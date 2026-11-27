import fs from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { fetchLastPrice, fetchRecentCandles } from "./candles.js";
import { getMintDecimals, makeConnection } from "./chain.js";
import { LAMPORTS_PER_SOL, PROJECT_ROOT, USDC_MINT, WSOL_MINT, describeConfig, type Config } from "./config.js";
import { loadKeypair } from "./jito.js";
import { getQuote } from "./jupiter.js";
import { log } from "./log.js";
import { LivePerps, PaperPerps, PerpsApi, perpPnlUsd, type PerpPosition, type PerpsVenue } from "./perps.js";
import { priceSolPerToken, toRaw, toUi } from "./pricing.js";
import { gridStep, makeGrid, movePct, riskExit, signalStep, type Dir, type GridState } from "./rules.js";
import { SIGNALS, warmupBars } from "./signals.js";
import { loadStrategy, type StrategyFile } from "./strategyConfig.js";
import { appendTrade } from "./tradeLog.js";
import { executeSwap } from "./trade.js";

const STATE_DIR = resolve(PROJECT_ROOT, "state");
export const KILL_FILE = resolve(STATE_DIR, "KILL");

interface SpotPosition {
  mint: string;
  decimals: number;
  amountRaw: string;
  spentLamports: string;
  /** SOL per token, from the executed (or paper) fill. */
  entryPriceSol: number;
  openedAt: string;
  signature?: string;
}

interface EngineState {
  version: 1;
  strategy: string;
  market: string;
  spot: SpotPosition | null;
  grid: GridState | null;
  dca: { lastBuyAt: number; buys: number };
  perp: PerpPosition | null;
  blocked: -1 | 0 | 1;
  day: string;
  tradesToday: number;
  lastTradeAt: number;
  realized: { sol: number; usd: number };
}

function emptyState(s: StrategyFile): EngineState {
  return {
    version: 1,
    strategy: s.strategy,
    market: s.market,
    spot: null,
    grid: null,
    dca: { lastBuyAt: 0, buys: 0 },
    perp: null,
    blocked: 0,
    day: new Date().toISOString().slice(0, 10),
    tradesToday: 0,
    lastTradeAt: 0,
    realized: { sol: 0, usd: 0 },
  };
}

export function hasOpenPositions(st: EngineState): boolean {
  return Boolean(st.spot || st.perp || st.grid?.slots.some((s) => s.holding));
}

export interface EngineStatus {
  running: boolean;
  killed: boolean;
  mode: "dry" | "live";
  strategy: string;
  market: string;
  startedAt: string | null;
  lastTickAt: string | null;
  lastDecision: string | null;
  lastError: string | null;
  tradesToday: number;
  realized: { sol: number; usd: number };
  positions: {
    spot: (SpotPosition & { markPriceSol?: number; movePct?: number; tokens: number }) | null;
    grid: { symbol: string; lo: number; hi: number; levels: number; holdingSlots: number; halted: boolean; lastPrice?: number } | null;
    perp: (PerpPosition & { markPrice?: number; pnlUsd?: number }) | null;
  };
  config: Record<string, unknown>;
}

/**
 * The trading engine. One instance runs one strategy at a time, ticking every pollIntervalSec.
 * Used by `npm run bot` (headless) and by the dashboard server.
 */
export class Engine {
  private state: EngineState | null = null;
  private strategy: StrategyFile | null = null;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private startedAt: string | null = null;
  private lastTickAt: string | null = null;
  private lastDecision: string | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private marks: { spotSol?: number; gridPrice?: number; perp?: number } = {};
  private connection: Connection;
  private decimals = new Map<string, number>();
  private walletCache: Keypair | undefined;
  private perps: PerpsVenue | null = null;

  constructor(private readonly cfg: Config) {
    this.connection = makeConnection(cfg.rpcUrl);
  }

  get mode(): "dry" | "live" {
    return this.cfg.dryRun ? "dry" : "live";
  }

  private stateFile(): string {
    return resolve(STATE_DIR, `engine.${this.mode}.json`);
  }

  private loadState(): EngineState | null {
    const f = this.stateFile();
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as EngineState) : null;
  }

  private saveState(): void {
    if (!this.state) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = this.stateFile();
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.state, null, 2) + "\n");
    fs.renameSync(`${f}.tmp`, f);
  }

  private wallet = (): Keypair => (this.walletCache ??= loadKeypair(this.cfg.keypairPath));

  isKilled(): boolean {
    return fs.existsSync(KILL_FILE);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Validate everything that can be validated before the first tick. */
  async start(): Promise<void> {
    if (this.running) throw new Error("Already running");
    if (this.isKilled()) throw new Error("Kill switch is active. Reset it first (dashboard or `npm run kill -- --reset`).");
    const strategy = loadStrategy(this.cfg);
    if (!this.cfg.dryRun) {
      this.wallet();
      if (strategy.market === "perps" && !this.cfg.enableLivePerps) {
        throw new Error("Live perps are disabled. Set ENABLE_LIVE_PERPS=true in .env (and keep the caps small).");
      }
    }
    let st = this.loadState();
    if (st && (st.strategy !== strategy.strategy || st.market !== strategy.market)) {
      if (hasOpenPositions(st)) {
        throw new Error(
          `State has open ${st.market}/${st.strategy} positions. Close them (kill switch flattens) before switching strategy.`,
        );
      }
      st = null;
    }
    this.state = st ?? emptyState(strategy);
    // A grid halted by its stop loss restarts from a fresh range once it holds nothing.
    if (this.state.grid?.halted && !this.state.grid.slots.some((x) => x.holding)) this.state.grid = null;
    this.strategy = strategy;
    if (strategy.market === "perps") {
      const api = new PerpsApi(this.cfg.perpsApiUrl);
      this.perps = this.cfg.dryRun ? new PaperPerps(api, this.cfg) : new LivePerps(api, this.cfg, this.connection, this.wallet);
    }
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.consecutiveErrors = 0;
    this.lastError = null;
    log("info", "engine_start", {
      ...describeConfig(this.cfg),
      mode: this.mode,
      strategy: strategy.strategy,
      market: strategy.market,
      timeframe: strategy.timeframe,
      perpsVenue: this.perps ? (this.perps.paper ? "paper" : "live") : undefined,
    });
    this.saveState();
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
        this.schedule((this.strategy?.pollIntervalSec ?? 30) * 1000);
      });
    }, ms);
  }

  /** Stop after the current tick. Positions stay open. */
  async stop(reason = "requested"): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ticking) await this.ticking;
    log("info", "engine_stop", { reason });
  }

  /**
   * Kill switch: stop, block restarts (state/KILL), and close every open position.
   * In dry-run the closes are paper closes; in live mode they are real transactions.
   */
  async kill(reason = "kill switch"): Promise<{ closed: string[]; errors: string[] }> {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(KILL_FILE, `${new Date().toISOString()} ${reason}\n`);
    await this.stop("kill");
    const closed: string[] = [];
    const errors: string[] = [];
    if (!this.state) this.state = this.loadState();
    if (!this.strategy) {
      try {
        this.strategy = loadStrategy(this.cfg);
      } catch (e) {
        errors.push(String(e));
      }
    }
    const st = this.state;
    if (!st || !this.strategy) return { closed, errors };
    if (st.perp && !this.perps) {
      const api = new PerpsApi(this.cfg.perpsApiUrl);
      this.perps = st.perp.paper ? new PaperPerps(api, this.cfg) : new LivePerps(api, this.cfg, this.connection, this.wallet);
    }
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
        closed.push(label);
      } catch (e) {
        errors.push(`${label}: ${e instanceof Error ? e.message : e}`);
      }
    };
    if (st.spot) await attempt("spot", () => this.closeSpot("kill_switch"));
    if (st.grid?.slots.some((s) => s.holding)) await attempt("grid", () => this.gridSellAll("kill_switch"));
    if (st.perp) await attempt("perp", () => this.closePerp("kill_switch"));
    this.saveState();
    log(errors.length ? "error" : "warn", "kill_switch", { reason, closed, errors });
    return { closed, errors };
  }

  resetKill(): void {
    if (fs.existsSync(KILL_FILE)) fs.unlinkSync(KILL_FILE);
    log("info", "kill_switch_reset");
  }

  // ------------------------------------------------------------------ tick

  private canOpen(): boolean {
    const st = this.state!;
    const s = this.strategy!;
    const today = new Date().toISOString().slice(0, 10);
    if (st.day !== today) {
      st.day = today;
      st.tradesToday = 0;
    }
    return st.tradesToday < s.risk.maxTradesPerDay && Date.now() - st.lastTradeAt >= s.risk.cooldownSec * 1000;
  }

  private countEntry(): void {
    this.state!.tradesToday++;
    this.state!.lastTradeAt = Date.now();
  }

  async tick(): Promise<void> {
    if (!this.strategy || !this.state) return;
    if (this.isKilled()) {
      log("warn", "kill_file_detected");
      await this.kill("kill file");
      return;
    }
    const s = this.strategy;
    try {
      if (s.market === "perps") await this.tickPerps();
      else if (s.strategy === "grid") await this.tickGrid();
      else if (s.strategy === "dca") await this.tickDca();
      else await this.tickSpotSignal();
      this.consecutiveErrors = 0;
      this.lastError = null;
    } catch (err) {
      this.consecutiveErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      log("error", "tick_error", { message: this.lastError, consecutiveErrors: this.consecutiveErrors });
      if (this.consecutiveErrors >= this.cfg.maxConsecutiveErrors) {
        log("error", "too_many_errors_stopping", { errors: this.consecutiveErrors });
        this.running = false;
      }
    } finally {
      this.lastTickAt = new Date().toISOString();
      this.saveState();
    }
  }

  private decide(text: string, data: Record<string, unknown> = {}): void {
    this.lastDecision = text;
    log("info", "tick", { strategy: this.strategy!.strategy, market: this.strategy!.market, decision: text, ...data });
  }

  /** Latest signal from the last closed candle, or null for strategies without one. */
  private async latestSignal(symbol: string, allowShort: boolean): Promise<-1 | 0 | 1> {
    const s = this.strategy!;
    const name = s.strategy as keyof typeof SIGNALS;
    const params = s.params[name] as unknown as Record<string, number>;
    const need = warmupBars(name, params) + 50;
    const candles = await fetchRecentCandles(symbol, s.timeframe, need);
    if (candles.length < warmupBars(name, params)) throw new Error(`Not enough candles for ${name} (${candles.length})`);
    const sig = SIGNALS[name](candles, params, allowShort);
    return sig[sig.length - 1] as -1 | 0 | 1;
  }

  private spotCfg(): Config {
    const s = this.strategy!;
    return { ...this.cfg, tokenMint: s.spot.tokenMint, slippageBps: s.spot.slippageBps };
  }

  private async tokenDecimals(mint: string): Promise<number> {
    if (!this.decimals.has(mint)) this.decimals.set(mint, await getMintDecimals(this.connection, mint));
    return this.decimals.get(mint)!;
  }

  /** Executable SOL-per-token price for selling `amountRaw` (or a reference buy if none held). */
  private async spotPriceSol(mint: string, decimals: number, amountRaw?: bigint): Promise<number> {
    if (amountRaw && amountRaw > 0n) {
      const q = await getQuote(this.spotCfg(), { inputMint: mint, outputMint: WSOL_MINT, amountRaw });
      return priceSolPerToken(BigInt(q.outAmount), amountRaw, decimals);
    }
    const lamports = toRaw(this.strategy!.spot.positionSizeSol, 9);
    const q = await getQuote(this.spotCfg(), { inputMint: WSOL_MINT, outputMint: mint, amountRaw: lamports });
    return priceSolPerToken(lamports, BigInt(q.outAmount), decimals);
  }

  private async buySpot(lamports: bigint, reason: string): Promise<{ amountRaw: bigint; signature?: string }> {
    const s = this.strategy!;
    const res = await executeSwap(this.spotCfg(), this.connection, { side: "buy", tokenMint: s.spot.tokenMint, amountRaw: lamports }, this.wallet);
    const amountRaw = res.tokenDeltaRaw && res.tokenDeltaRaw > 0n ? res.tokenDeltaRaw : res.expectedOutRaw;
    const decimals = await this.tokenDecimals(s.spot.tokenMint);
    appendTrade({
      mode: this.mode,
      market: "spot",
      strategy: s.strategy,
      action: "buy",
      side: "long",
      instrument: s.spot.tokenMint,
      price: Number(lamports) / LAMPORTS_PER_SOL / toUi(amountRaw, decimals),
      size: `${toUi(lamports, 9)} SOL`,
      reason,
      signature: res.signature,
    });
    return { amountRaw, signature: res.signature };
  }

  private async sellSpot(amountRaw: bigint, spentLamports: bigint, reason: string): Promise<{ receivedLamports: bigint; signature?: string }> {
    const s = this.strategy!;
    const res = await executeSwap(this.spotCfg(), this.connection, { side: "sell", tokenMint: s.spot.tokenMint, amountRaw }, this.wallet);
    const received = res.expectedOutRaw;
    const pnlSol = Number(received - spentLamports) / LAMPORTS_PER_SOL;
    this.state!.realized.sol += pnlSol;
    const decimals = await this.tokenDecimals(s.spot.tokenMint);
    appendTrade({
      mode: this.mode,
      market: "spot",
      strategy: s.strategy,
      action: "sell",
      side: "long",
      instrument: s.spot.tokenMint,
      price: Number(received) / LAMPORTS_PER_SOL / toUi(amountRaw, decimals),
      size: `${toUi(amountRaw, decimals)} tokens`,
      pnl: pnlSol,
      pnlUnit: "SOL",
      reason,
      signature: res.signature,
    });
    return { receivedLamports: received, signature: res.signature };
  }

  private async openSpot(lamports: bigint, reason: string): Promise<void> {
    const s = this.strategy!;
    const decimals = await this.tokenDecimals(s.spot.tokenMint);
    const r = await this.buySpot(lamports, reason);
    const prev = this.state!.spot;
    const amount = BigInt(prev?.amountRaw ?? "0") + r.amountRaw;
    const spent = BigInt(prev?.spentLamports ?? "0") + lamports;
    this.state!.spot = {
      mint: s.spot.tokenMint,
      decimals,
      amountRaw: amount.toString(),
      spentLamports: spent.toString(),
      entryPriceSol: Number(spent) / LAMPORTS_PER_SOL / toUi(amount, decimals),
      openedAt: prev?.openedAt ?? new Date().toISOString(),
      signature: r.signature,
    };
    this.countEntry();
  }

  private async closeSpot(reason: string): Promise<void> {
    const p = this.state!.spot;
    if (!p) return;
    await this.sellSpot(BigInt(p.amountRaw), BigInt(p.spentLamports), reason);
    this.state!.spot = null;
  }

  private async tickSpotSignal(): Promise<void> {
    const s = this.strategy!;
    const st = this.state!;
    const decimals = await this.tokenDecimals(s.spot.tokenMint);
    const pos = st.spot;
    const priceSol = await this.spotPriceSol(s.spot.tokenMint, decimals, pos ? BigInt(pos.amountRaw) : undefined);
    this.marks.spotSol = priceSol;

    let signal: -1 | 0 | 1 | null;
    if (s.strategy === "price_trigger") {
      const pt = s.params.price_trigger;
      let price = priceSol;
      if (pt.priceUnit === "USDC") {
        const q = await getQuote(this.spotCfg(), { inputMint: WSOL_MINT, outputMint: USDC_MINT, amountRaw: BigInt(LAMPORTS_PER_SOL) });
        price = priceSol * (Number(q.outAmount) / 1e6);
      }
      signal = price <= pt.buyPrice ? 1 : null;
    } else {
      signal = await this.latestSignal(s.spot.candleSymbol, false);
    }
    if (st.blocked && signal !== st.blocked) st.blocked = 0;
    const action = signalStep({
      position: pos ? { dir: 1, entry: pos.entryPriceSol } : null,
      price: priceSol,
      signal,
      allowShort: false,
      takeProfitPct: s.risk.takeProfitPct,
      stopLossPct: s.risk.stopLossPct,
      blocked: st.blocked,
      canOpen: this.canOpen(),
    });
    this.decide(action.kind === "hold" ? `hold (${action.reason})` : `${action.kind} (${action.reason})`, {
      priceSol,
      signal,
      move: pos ? movePct(1, pos.entryPriceSol, priceSol) : undefined,
    });
    if (action.kind === "open") await this.openSpot(toRaw(s.spot.positionSizeSol, 9), action.reason);
    if (action.kind === "close") {
      await this.closeSpot(action.reason);
      if (action.block) st.blocked = 1;
    }
  }

  private async tickDca(): Promise<void> {
    const s = this.strategy!;
    const st = this.state!;
    const p = s.params.dca;
    const decimals = await this.tokenDecimals(s.spot.tokenMint);
    if (st.spot) {
      const price = await this.spotPriceSol(s.spot.tokenMint, decimals, BigInt(st.spot.amountRaw));
      this.marks.spotSol = price;
      const exit = riskExit(1, st.spot.entryPriceSol, price, s.risk.takeProfitPct, s.risk.stopLossPct);
      if (exit) {
        this.decide(`close (${exit})`, { priceSol: price, avgEntry: st.spot.entryPriceSol });
        await this.closeSpot(exit);
        st.dca = { lastBuyAt: st.dca.lastBuyAt, buys: 0 };
        return;
      }
    }
    const due = Date.now() - st.dca.lastBuyAt >= p.intervalHours * 3_600_000;
    if (st.dca.buys >= p.maxBuys) return this.decide("hold (max_buys_reached)");
    if (!due) return this.decide("hold (not_due)", { nextBuyAt: new Date(st.dca.lastBuyAt + p.intervalHours * 3_600_000).toISOString() });
    if (!this.canOpen()) return this.decide("hold (limit_or_cooldown)");
    this.decide("buy (dca_interval)", { buyNumber: st.dca.buys + 1 });
    await this.openSpot(toRaw(p.amountSol, 9), "dca_interval");
    st.dca = { lastBuyAt: Date.now(), buys: st.dca.buys + 1 };
  }

  private async gridSellAll(reason: string): Promise<void> {
    const g = this.state!.grid;
    if (!g) return;
    let amount = 0n;
    let spent = 0n;
    for (const sl of g.slots) {
      if (!sl.holding) continue;
      amount += BigInt(sl.amountRaw);
      spent += BigInt(sl.spentLamports);
    }
    if (amount === 0n) return;
    await this.sellSpot(amount, spent, reason);
    for (const sl of g.slots) Object.assign(sl, { holding: false, amountRaw: "0", spentLamports: "0" });
  }

  private async tickGrid(): Promise<void> {
    const s = this.strategy!;
    const st = this.state!;
    const p = s.params.grid;
    const price = await fetchLastPrice(s.spot.candleSymbol);
    this.marks.gridPrice = price;
    const build = async () => {
      const candles = await fetchRecentCandles(s.spot.candleSymbol, s.timeframe, p.lookbackCandles);
      const lo = Math.min(...candles.map((c) => c.l));
      const hi = Math.max(...candles.map((c) => c.h));
      st.grid = makeGrid(s.spot.candleSymbol, lo, hi, p.levels, p.padPct, price);
      log("info", "grid_range", { symbol: s.spot.candleSymbol, lo: st.grid.lo, hi: st.grid.hi, levels: p.levels, price });
    };
    if (!st.grid || st.grid.symbol !== s.spot.candleSymbol || st.grid.slots.length !== p.levels) {
      if (st.grid?.slots.some((x) => x.holding)) throw new Error("Grid settings changed while holding slots; flatten first.");
      await build();
    }
    const g = st.grid!;
    const a = gridStep(g, price, { stopLossPct: s.risk.stopLossPct, rerange: p.rerange, canBuy: this.canOpen() });
    const holding = g.slots.filter((x) => x.holding).length;
    this.decide(a.kind === "none" ? `hold (${a.reason})` : a.kind === "buy" || a.kind === "sell" ? `${a.kind} slot ${a.slot}` : a.kind, {
      price,
      lo: g.lo,
      hi: g.hi,
      holdingSlots: holding,
    });
    switch (a.kind) {
      case "rerange":
        await build();
        return;
      case "stop_all":
        await this.gridSellAll("grid_stop_loss");
        g.halted = true;
        return;
      case "buy": {
        const lamports = toRaw(p.slotSizeSol, 9);
        const r = await this.buySpot(lamports, `grid level ${g.levels[a.slot]!.toPrecision(6)}`);
        Object.assign(g.slots[a.slot]!, { holding: true, armed: false, amountRaw: r.amountRaw.toString(), spentLamports: lamports.toString(), boughtAt: Date.now() });
        this.countEntry();
        return;
      }
      case "sell": {
        const sl = g.slots[a.slot]!;
        await this.sellSpot(BigInt(sl.amountRaw), BigInt(sl.spentLamports), `grid level ${g.levels[a.slot + 1]!.toPrecision(6)}`);
        Object.assign(sl, { holding: false, armed: true, amountRaw: "0", spentLamports: "0" });
        return;
      }
    }
  }

  private async openPerp(dir: Dir, reason: string): Promise<void> {
    const s = this.strategy!;
    const pos = await this.perps!.open({
      asset: s.perps.asset,
      side: dir === 1 ? "long" : "short",
      collateralUsd: s.perps.collateralUsd,
      leverage: s.perps.leverage,
      stopLossPct: s.risk.stopLossPct,
      takeProfitPct: s.risk.takeProfitPct,
      slippageBps: s.perps.slippageBps,
    });
    this.state!.perp = pos;
    this.countEntry();
    appendTrade({
      mode: this.mode,
      market: "perps",
      strategy: s.strategy,
      action: "open",
      side: pos.side,
      instrument: `${pos.asset}-PERP`,
      price: pos.entryPrice,
      size: `$${pos.sizeUsd.toFixed(2)} (${pos.leverage}x, SL ${pos.stopLossPrice.toFixed(4)})`,
      reason: `${reason}${pos.paper ? " (paper)" : ""}`,
      signature: pos.signature,
    });
  }

  private async closePerp(reason: string): Promise<void> {
    const pos = this.state!.perp;
    if (!pos) return;
    const r = await this.perps!.close(pos);
    this.state!.realized.usd += r.pnlUsd;
    this.state!.perp = null;
    appendTrade({
      mode: this.mode,
      market: "perps",
      strategy: this.strategy!.strategy,
      action: "close",
      side: pos.side,
      instrument: `${pos.asset}-PERP`,
      price: r.exitPrice,
      size: `$${pos.sizeUsd.toFixed(2)}`,
      pnl: r.pnlUsd,
      pnlUnit: "USD",
      reason: `${reason}${pos.paper ? " (paper)" : ""}`,
      signature: r.signature,
    });
  }

  private async tickPerps(): Promise<void> {
    const s = this.strategy!;
    const st = this.state!;
    const venue = this.perps!;
    // Live: the keeper may have executed the on-chain TP/SL already.
    if (st.perp && !venue.paper) {
      const open = await venue.openPositions();
      if (!open.some((p) => p.positionPubkey === st.perp!.positionPubkey)) {
        log("warn", "perp_closed_externally", { positionPubkey: st.perp.positionPubkey, note: "likely on-chain TP/SL" });
        appendTrade({
          mode: this.mode,
          market: "perps",
          strategy: s.strategy,
          action: "close",
          side: st.perp.side,
          instrument: `${st.perp.asset}-PERP`,
          price: NaN,
          size: `$${st.perp.sizeUsd.toFixed(2)}`,
          reason: "closed on-chain (TP/SL or liquidation); check the explorer for PnL",
        });
        st.blocked = st.perp.side === "long" ? 1 : -1;
        st.perp = null;
      }
    }
    const mark = await venue.markPrice(s.perps.asset);
    this.marks.perp = mark;
    const signal = await this.latestSignal(`${s.perps.asset}USDT`, s.perps.allowShort);
    if (st.blocked && signal !== st.blocked) st.blocked = 0;
    const pos = st.perp;
    const action = signalStep({
      position: pos ? { dir: pos.side === "long" ? 1 : -1, entry: pos.entryPrice } : null,
      price: mark,
      signal,
      allowShort: s.perps.allowShort,
      takeProfitPct: s.risk.takeProfitPct,
      stopLossPct: s.risk.stopLossPct,
      blocked: st.blocked,
      canOpen: this.canOpen(),
    });
    this.decide(action.kind === "hold" ? `hold (${action.reason})` : `${action.kind} (${action.reason})`, {
      asset: s.perps.asset,
      mark,
      signal,
      pnlUsd: pos ? perpPnlUsd(pos, mark) : undefined,
    });
    if (action.kind === "open") await this.openPerp(action.dir, action.reason);
    if (action.kind === "close") {
      const side = pos!.side;
      await this.closePerp(action.reason);
      if (action.block) st.blocked = side === "long" ? 1 : -1;
    }
  }

  // ------------------------------------------------------------------ status

  status(): EngineStatus {
    const st = this.state ?? this.loadState();
    const s = this.strategy;
    const spot = st?.spot
      ? {
          ...st.spot,
          tokens: toUi(st.spot.amountRaw, st.spot.decimals),
          markPriceSol: this.marks.spotSol,
          movePct: this.marks.spotSol ? movePct(1, st.spot.entryPriceSol, this.marks.spotSol) : undefined,
        }
      : null;
    const grid = st?.grid
      ? {
          symbol: st.grid.symbol,
          lo: st.grid.lo,
          hi: st.grid.hi,
          levels: st.grid.slots.length,
          holdingSlots: st.grid.slots.filter((x) => x.holding).length,
          halted: st.grid.halted,
          lastPrice: this.marks.gridPrice,
        }
      : null;
    const perp = st?.perp
      ? { ...st.perp, markPrice: this.marks.perp, pnlUsd: this.marks.perp ? perpPnlUsd(st.perp, this.marks.perp) : undefined }
      : null;
    return {
      running: this.running,
      killed: this.isKilled(),
      mode: this.mode,
      strategy: s?.strategy ?? st?.strategy ?? "-",
      market: s?.market ?? st?.market ?? "-",
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastDecision: this.lastDecision,
      lastError: this.lastError,
      tradesToday: st?.tradesToday ?? 0,
      realized: st?.realized ?? { sol: 0, usd: 0 },
      positions: { spot, grid, perp },
      config: describeConfig(this.cfg),
    };
  }
}
