import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  LAMPORTS_PER_SOL,
  WSOL_MINT,
  type Config,
} from "./config.js";
import { getTokenBalanceRaw } from "./chain.js";
import { getQuote, type Quote } from "./jupiter.js";
import { getTipAccount, sendViaJito } from "./jito.js";
import { log } from "./log.js";
import { buildSwapTransaction, confirmSignature } from "./tx.js";

export type Side = "buy" | "sell";

export interface SwapRequest {
  side: Side;
  tokenMint: string;
  /** Raw units of the INPUT mint (lamports for buy, token units for sell). */
  amountRaw: bigint;
}

export interface SwapResult {
  dryRun: boolean;
  quote: Quote;
  inAmountRaw: bigint;
  /** Quote estimate of what comes out. */
  expectedOutRaw: bigint;
  signature?: string;
  sentVia?: "jito" | "rpc";
  /** Real token balance change after a live buy, when it could be measured. */
  tokenDeltaRaw?: bigint;
}

const RENT_TOKEN_ACCOUNT = 2_039_280n; // standard SPL token account rent-exempt minimum
const BASE_FEE = 5_000n;

/** Worst-case SOL a live swap needs up front, including rent that Jupiter later refunds (wSOL). */
export function estimateRequiredLamports(
  cfg: Config,
  side: Side,
  amountRaw: bigint,
  targetAtaMissing: boolean,
): bigint {
  const tip = cfg.sendVia === "jito" ? BigInt(cfg.jitoTipLamports) : 0n;
  const spend = side === "buy" ? amountRaw : 0n;
  const wsolRent = RENT_TOKEN_ACCOUNT; // temporary wSOL account, refunded by the cleanup instruction
  const ataRent = side === "buy" && targetAtaMissing ? RENT_TOKEN_ACCOUNT : 0n;
  return (
    spend + wsolRent + ataRent + BASE_FEE + BigInt(cfg.priorityFeeLamports) + tip
  );
}

export async function executeSwap(
  cfg: Config,
  connection: Connection,
  req: SwapRequest,
  wallet: () => Keypair,
): Promise<SwapResult> {
  const inputMint = req.side === "buy" ? WSOL_MINT : req.tokenMint;
  const outputMint = req.side === "buy" ? req.tokenMint : WSOL_MINT;

  const quote = await getQuote(cfg, {
    inputMint,
    outputMint,
    amountRaw: req.amountRaw,
  });
  const base = {
    quote,
    inAmountRaw: BigInt(quote.inAmount),
    expectedOutRaw: BigInt(quote.outAmount),
  };
  const route = quote.routePlan.map((r) => r.swapInfo?.label ?? "?").join(" > ");

  if (cfg.dryRun) {
    log("info", "dry_run_swap", {
      side: req.side,
      note: "DRY_RUN is on: nothing was signed or sent",
      inAmount: quote.inAmount,
      expectedOut: quote.outAmount,
      minOut: quote.otherAmountThreshold,
      priceImpactPct: quote.priceImpactPct,
      route,
    });
    return { dryRun: true, ...base };
  }

  const payer = wallet();
  const owner = payer.publicKey;

  // Pre-flight balance check so a live swap does not fail half-way on rent or fees.
  const [balance, tokenBefore] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    getTokenBalanceRaw(connection, owner, req.tokenMint),
  ]);
  const needed = estimateRequiredLamports(
    cfg,
    req.side,
    req.amountRaw,
    tokenBefore.accounts === 0,
  );
  const reserve = BigInt(Math.round(cfg.minSolReserve * LAMPORTS_PER_SOL));
  if (BigInt(balance) < needed + reserve) {
    throw new Error(
      `Not enough SOL: have ${balance} lamports, need about ${needed + reserve} ` +
        `(swap/fees/tip/rent ${needed} + reserve ${reserve}).`,
    );
  }
  if (req.side === "sell" && tokenBefore.raw < req.amountRaw) {
    throw new Error(
      `Token balance ${tokenBefore.raw} is below the sell amount ${req.amountRaw}.`,
    );
  }

  const send = async (viaJito: boolean, q: Quote) => {
    const tip = viaJito
      ? { account: await getTipAccount(cfg), lamports: cfg.jitoTipLamports }
      : undefined;
    const built = await buildSwapTransaction(cfg, connection, q, owner, tip);
    built.tx.sign([payer]);
    const signature = bs58.encode(built.tx.signatures[0]!);
    const serialized = built.tx.serialize();
    if (viaJito) {
      const returned = await sendViaJito(cfg, serialized);
      if (returned !== signature) {
        log("warn", "signature_mismatch", { local: signature, returned });
      }
    } else {
      await connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        maxRetries: 3,
      });
    }
    return { signature, lastValid: built.lastValidBlockHeight };
  };

  let sent: { signature: string; lastValid: number };
  let sentVia: "jito" | "rpc";
  if (cfg.sendVia === "jito") {
    try {
      sent = await send(true, quote);
      sentVia = "jito";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Only fall back when Jito refused the send itself. After an accepted send we never
      // resend, because two different transactions could both land.
      if (!cfg.fallbackToRpc) throw err;
      log("warn", "jito_send_failed_fallback_rpc", { reason });
      const fresh = await getQuote(cfg, {
        inputMint,
        outputMint,
        amountRaw: req.amountRaw,
      });
      sent = await send(false, fresh);
      sentVia = "rpc";
    }
  } else {
    sent = await send(false, quote);
    sentVia = "rpc";
  }

  log("info", "swap_sent", { side: req.side, signature: sent.signature, via: sentVia });
  const status = await confirmSignature(connection, sent.signature, sent.lastValid);
  if (status !== "confirmed") {
    throw new Error(`Swap ${sent.signature} ${status}`);
  }

  let tokenDeltaRaw: bigint | undefined;
  try {
    const after = await getTokenBalanceRaw(connection, owner, req.tokenMint);
    tokenDeltaRaw = after.raw - tokenBefore.raw;
  } catch {
    tokenDeltaRaw = undefined;
  }
  log("info", "swap_confirmed", {
    side: req.side,
    signature: sent.signature,
    via: sentVia,
    inAmount: quote.inAmount,
    expectedOut: quote.outAmount,
    tokenDelta: tokenDeltaRaw?.toString(),
  });
  return {
    dryRun: false,
    ...base,
    signature: sent.signature,
    sentVia,
    tokenDeltaRaw,
  };
}
