import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  HARD_MAX_LEVERAGE,
  HARD_MAX_PERP_COLLATERAL_USD,
  JUPITER_MIN_PERP_COLLATERAL_USD,
  WSOL_MINT,
  type Config,
} from "./config.js";
import { log } from "./log.js";
import type { PerpAsset } from "./strategyConfig.js";
import { confirmSignature } from "./tx.js";

/**
 * Jupiter Perps through Jupiter's perps API (https://perps-api.jup.ag/v2), the same endpoints the
 * official Jupiter CLI (github.com/jup-ag/cli, src/clients/PerpsClient.ts) uses:
 *   POST /positions/increase  -> unsigned transaction + quote (optionally with TP/SL requests)
 *   POST /positions/decrease  -> unsigned transaction + quote
 *   POST /transaction/execute -> submits the user-signed transaction; Jupiter adds its co-signature
 *   GET  /positions, /market-stats
 * The returned transactions use "instant" increase/decrease instructions that need a Jupiter
 * co-signer, so they cannot be sent to a plain RPC; they must go through /transaction/execute.
 */

export const PERP_ASSET_MINTS: Record<PerpAsset, string> = {
  SOL: WSOL_MINT,
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
};

/** Programs a Jupiter Perps transaction is allowed to touch before we sign it. */
const ALLOWED_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "Ed25519SigVerify111111111111111111111111111",
  "DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e", // Jupiter "doves" oracle
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu", // Jupiter Perpetuals program
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter swap (collateral swaps)
]);

const micro = (usd: number) => Math.round(usd * 1e6).toString();
const fromMicro = (s: string | undefined) => (s === undefined ? NaN : Number(s) / 1e6);

export type PerpSide = "long" | "short";

export interface PerpPosition {
  asset: PerpAsset;
  side: PerpSide;
  entryPrice: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  stopLossPrice: number;
  takeProfitPrice: number | null;
  liquidationPrice: number | null;
  openFeeUsd: number;
  openedAt: string;
  positionPubkey: string | null;
  paper: boolean;
  signature?: string;
}

export interface OpenRequest {
  asset: PerpAsset;
  side: PerpSide;
  collateralUsd: number;
  leverage: number;
  stopLossPct: number;
  takeProfitPct: number; // 0 = none
  slippageBps: number;
}

export interface CloseResult {
  exitPrice: number;
  pnlUsd: number;
  feesUsd: number;
  signature?: string;
}

export interface PerpsVenue {
  readonly paper: boolean;
  markPrice(asset: PerpAsset): Promise<number>;
  open(req: OpenRequest): Promise<PerpPosition>;
  close(pos: PerpPosition): Promise<CloseResult>;
  /** Live only: positions Jupiter reports for the wallet. */
  openPositions(): Promise<PerpPosition[]>;
}

/** Enforce the code-level caps. Throws before anything is built or signed. */
export function assertPerpCaps(cfg: Pick<Config, "maxLeverage" | "maxPerpCollateralUsd">, req: OpenRequest): void {
  const maxLev = Math.min(cfg.maxLeverage, HARD_MAX_LEVERAGE);
  const maxCol = Math.min(cfg.maxPerpCollateralUsd, HARD_MAX_PERP_COLLATERAL_USD);
  if (!(req.leverage > 1 && req.leverage <= maxLev)) {
    throw new Error(`Leverage ${req.leverage} not allowed (must be > 1 and <= ${maxLev}, hard cap ${HARD_MAX_LEVERAGE})`);
  }
  if (!(req.collateralUsd >= JUPITER_MIN_PERP_COLLATERAL_USD && req.collateralUsd <= maxCol)) {
    throw new Error(`Collateral $${req.collateralUsd} not allowed (must be $${JUPITER_MIN_PERP_COLLATERAL_USD}-$${maxCol})`);
  }
  if (!(req.stopLossPct > 0)) throw new Error("A stop loss is mandatory for perps");
  if (req.stopLossPct >= 100 / req.leverage) {
    throw new Error(`Stop loss ${req.stopLossPct}% is beyond liquidation at ${req.leverage}x`);
  }
}

export function stopAndTarget(entry: number, side: PerpSide, slPct: number, tpPct: number) {
  const dir = side === "long" ? 1 : -1;
  return {
    stopLossPrice: entry * (1 - (dir * slPct) / 100),
    takeProfitPrice: tpPct > 0 ? entry * (1 + (dir * tpPct) / 100) : null,
  };
}

/** Unrealized PnL in USD before close fees. */
export function perpPnlUsd(pos: PerpPosition, mark: number): number {
  const dir = pos.side === "long" ? 1 : -1;
  return dir * ((mark - pos.entryPrice) / pos.entryPrice) * pos.sizeUsd;
}

// ---------------------------------------------------------------- API client

interface MarketStats {
  price: string;
}
interface ApiPosition {
  asset: string;
  positionPubkey: string;
  side: string;
  leverage: string;
  sizeUsd: string;
  collateralUsd: string;
  entryPriceUsd: string;
  markPriceUsd: string;
  liquidationPriceUsd: string;
  openFeesUsd: string;
  pnlAfterFeesUsd: string;
  createdTime: number;
  tpslRequests: Array<{ requestType: string; triggerPriceUsd: string | null }>;
}
export interface IncreaseResponse {
  positionPubkey: string;
  quote: {
    averagePriceUsd: string;
    leverage: string;
    liquidationPriceUsd: string;
    openFeeUsd: string;
    positionCollateralUsd: string;
    sizeUsdDelta: string;
    priceImpactFeeUsd: string;
  };
  serializedTxBase64: string;
  tpsl?: Array<{ requestType: string; pubkey: string }>;
  txMetadata: { lastValidBlockHeight: string; transactionFeeLamports?: string; accountRentLamports?: string };
}
interface DecreaseResponse {
  positionPubkey: string;
  quote: { pnlAfterFeesUsd: string; totalFeeUsd: string; transferAmountUsd: string };
  serializedTxBase64: string;
  txMetadata: { lastValidBlockHeight: string };
}

export class PerpsApi {
  constructor(private readonly baseUrl: string) {}

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Perps API ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || (json as { code?: string }).code) {
      const j = json as { code?: string; message?: string; metadata?: { simulationError?: unknown } };
      const sim = j.metadata?.simulationError ? ` simulation=${JSON.stringify(j.metadata.simulationError)}` : "";
      throw new Error(`Perps API ${path} failed (${res.status}): ${j.code ?? ""} ${j.message ?? text.slice(0, 200)}${sim}`);
    }
    return json as T;
  }

  async markPrice(asset: PerpAsset): Promise<number> {
    const s = await this.req<MarketStats>("GET", `market-stats?mint=${PERP_ASSET_MINTS[asset]}`);
    const p = Number(s.price);
    if (!Number.isFinite(p) || p <= 0) throw new Error(`Bad perps price for ${asset}`);
    return p;
  }

  positions(wallet: string) {
    return this.req<{ dataList: ApiPosition[] }>("GET", `positions?walletAddress=${wallet}`);
  }

  increase(body: Record<string, unknown>) {
    return this.req<IncreaseResponse>("POST", "positions/increase", body);
  }

  decrease(body: Record<string, unknown>) {
    return this.req<DecreaseResponse>("POST", "positions/decrease", body);
  }

  execute(action: string, serializedTxBase64: string) {
    return this.req<{ action: string; txid: string }>("POST", "transaction/execute", { action, serializedTxBase64 });
  }
}

/** Check an API-built transaction before signing: our wallet pays, and only known programs are called. */
export function inspectPerpsTx(b64: string, wallet: PublicKey): VersionedTransaction {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const keys = tx.message.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) throw new Error("Perps tx fee payer is not our wallet; refusing to sign");
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex]?.toBase58();
    if (!program || !ALLOWED_PROGRAMS.has(program)) {
      throw new Error(`Perps tx calls unexpected program ${program}; refusing to sign`);
    }
  }
  return tx;
}

// ---------------------------------------------------------------- paper venue

/** Assumed per-side cost for paper trading (Jupiter base fee ~0.06% plus a little price impact). */
export const PAPER_PERP_FEE_RATE = 0.0007;

export class PaperPerps implements PerpsVenue {
  readonly paper = true;
  constructor(
    private readonly api: PerpsApi,
    private readonly cfg: Pick<Config, "maxLeverage" | "maxPerpCollateralUsd">,
  ) {}

  markPrice(asset: PerpAsset) {
    return this.api.markPrice(asset);
  }

  async open(req: OpenRequest): Promise<PerpPosition> {
    assertPerpCaps(this.cfg, req);
    const entry = await this.markPrice(req.asset);
    const sizeUsd = req.collateralUsd * req.leverage;
    const fee = sizeUsd * PAPER_PERP_FEE_RATE;
    const { stopLossPrice, takeProfitPrice } = stopAndTarget(entry, req.side, req.stopLossPct, req.takeProfitPct);
    const dir = req.side === "long" ? 1 : -1;
    return {
      asset: req.asset,
      side: req.side,
      entryPrice: entry,
      sizeUsd,
      collateralUsd: req.collateralUsd - fee,
      leverage: req.leverage,
      stopLossPrice,
      takeProfitPrice,
      liquidationPrice: entry * (1 - (dir * 100) / req.leverage / 100),
      openFeeUsd: fee,
      openedAt: new Date().toISOString(),
      positionPubkey: null,
      paper: true,
    };
  }

  async close(pos: PerpPosition): Promise<CloseResult> {
    const exit = await this.markPrice(pos.asset);
    const fee = pos.sizeUsd * PAPER_PERP_FEE_RATE;
    return { exitPrice: exit, pnlUsd: perpPnlUsd(pos, exit) - fee - pos.openFeeUsd, feesUsd: fee + pos.openFeeUsd };
  }

  async openPositions(): Promise<PerpPosition[]> {
    return [];
  }
}

// ---------------------------------------------------------------- live venue

export class LivePerps implements PerpsVenue {
  readonly paper = false;
  constructor(
    private readonly api: PerpsApi,
    private readonly cfg: Config,
    private readonly connection: Connection,
    private readonly wallet: () => Keypair,
  ) {}

  markPrice(asset: PerpAsset) {
    return this.api.markPrice(asset);
  }

  /** Build the increase transaction and check it. Shared by live open and build-only checks. */
  async buildOpen(req: OpenRequest, owner: PublicKey) {
    assertPerpCaps(this.cfg, req);
    const [mark, solPrice] = await Promise.all([this.markPrice(req.asset), this.markPrice("SOL")]);
    const lamports = Math.floor((req.collateralUsd / solPrice) * 1e9);
    const { stopLossPrice, takeProfitPrice } = stopAndTarget(mark, req.side, req.stopLossPct, req.takeProfitPct);
    const tpsl = [{ receiveToken: "SOL", triggerPrice: micro(stopLossPrice), requestType: "sl" }];
    if (takeProfitPrice) tpsl.push({ receiveToken: "SOL", triggerPrice: micro(takeProfitPrice), requestType: "tp" });

    const res = await this.api.increase({
      asset: req.asset,
      inputToken: "SOL",
      inputTokenAmount: String(lamports),
      side: req.side,
      maxSlippageBps: String(req.slippageBps),
      leverage: String(req.leverage),
      walletAddress: owner.toBase58(),
      tpsl,
    });

    // Re-check the quote the API returned against our caps before anything is signed.
    const lev = Number(res.quote.leverage);
    const liq = fromMicro(res.quote.liquidationPriceUsd);
    if (!(lev <= Math.min(this.cfg.maxLeverage, HARD_MAX_LEVERAGE) + 0.05)) throw new Error(`Quoted leverage ${lev} above cap`);
    if (req.side === "long" ? !(stopLossPrice > liq) : !(stopLossPrice < liq)) {
      throw new Error(`Stop loss ${stopLossPrice} is not before liquidation ${liq}`);
    }
    if (!res.tpsl?.some((t) => t.requestType === "sl")) throw new Error("API response has no stop-loss request");
    const tx = inspectPerpsTx(res.serializedTxBase64, owner);
    return { res, tx, mark, stopLossPrice, takeProfitPrice, lamports };
  }

  async open(req: OpenRequest): Promise<PerpPosition> {
    const payer = this.wallet();
    const built = await this.buildOpen(req, payer.publicKey);
    built.tx.sign([payer]);
    const signed = Buffer.from(built.tx.serialize()).toString("base64");
    const exec = await this.api.execute("increase-position", signed);
    log("info", "perp_open_sent", { signature: exec.txid, asset: req.asset, side: req.side });
    const status = await confirmSignature(this.connection, exec.txid, Number(built.res.txMetadata.lastValidBlockHeight));
    if (status !== "confirmed") throw new Error(`Perp open ${exec.txid} ${status}`);
    const q = built.res.quote;
    return {
      asset: req.asset,
      side: req.side,
      entryPrice: fromMicro(q.averagePriceUsd),
      sizeUsd: fromMicro(q.sizeUsdDelta),
      collateralUsd: fromMicro(q.positionCollateralUsd),
      leverage: Number(q.leverage),
      stopLossPrice: built.stopLossPrice,
      takeProfitPrice: built.takeProfitPrice,
      liquidationPrice: fromMicro(q.liquidationPriceUsd),
      openFeeUsd: fromMicro(q.openFeeUsd),
      openedAt: new Date().toISOString(),
      positionPubkey: built.res.positionPubkey,
      paper: false,
      signature: exec.txid,
    };
  }

  async close(pos: PerpPosition): Promise<CloseResult> {
    if (!pos.positionPubkey) throw new Error("Live close needs a position pubkey");
    const payer = this.wallet();
    const res = await this.api.decrease({
      positionPubkey: pos.positionPubkey,
      receiveToken: "SOL",
      entirePosition: true,
      maxSlippageBps: "200",
    });
    const tx = inspectPerpsTx(res.serializedTxBase64, payer.publicKey);
    tx.sign([payer]);
    const exec = await this.api.execute("decrease-position", Buffer.from(tx.serialize()).toString("base64"));
    const status = await confirmSignature(this.connection, exec.txid, Number(res.txMetadata.lastValidBlockHeight));
    if (status !== "confirmed") throw new Error(`Perp close ${exec.txid} ${status}`);
    return {
      exitPrice: await this.markPrice(pos.asset),
      pnlUsd: fromMicro(res.quote.pnlAfterFeesUsd),
      feesUsd: fromMicro(res.quote.totalFeeUsd),
      signature: exec.txid,
    };
  }

  async openPositions(): Promise<PerpPosition[]> {
    const { dataList } = await this.api.positions(this.wallet().publicKey.toBase58());
    // All USD amounts from this endpoint are micro-USD strings (as the official CLI decodes them).
    return dataList.map((p) => {
      const sl = p.tpslRequests.find((t) => t.requestType === "sl")?.triggerPriceUsd;
      const tp = p.tpslRequests.find((t) => t.requestType === "tp")?.triggerPriceUsd;
      return {
        asset: p.asset as PerpAsset,
        side: p.side as PerpSide,
        entryPrice: fromMicro(p.entryPriceUsd),
        sizeUsd: fromMicro(p.sizeUsd),
        collateralUsd: fromMicro(p.collateralUsd),
        leverage: Number(p.leverage),
        stopLossPrice: sl ? fromMicro(sl) : NaN,
        takeProfitPrice: tp ? fromMicro(tp) : null,
        liquidationPrice: fromMicro(p.liquidationPriceUsd),
        openFeeUsd: fromMicro(p.openFeesUsd),
        openedAt: new Date(p.createdTime < 1e12 ? p.createdTime * 1000 : p.createdTime).toISOString(),
        positionPubkey: p.positionPubkey,
        paper: false,
      };
    });
  }
}

export function signatureOf(tx: VersionedTransaction): string {
  return bs58.encode(tx.signatures[0]!);
}
