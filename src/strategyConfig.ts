import fs from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { TIMEFRAMES, type Timeframe } from "./candles.js";
import {
  HARD_MAX_LEVERAGE,
  HARD_MAX_PERP_COLLATERAL_USD,
  JUPITER_MIN_PERP_COLLATERAL_USD,
  PROJECT_ROOT,
  WSOL_MINT,
} from "./config.js";

export const STRATEGY_NAMES = [
  "grid",
  "ma_cross",
  "rsi",
  "bollinger",
  "donchian",
  "dca",
  "price_trigger",
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];
export type MarketKind = "spot" | "perps";
export const PERP_ASSETS = ["SOL", "ETH", "BTC"] as const;
export type PerpAsset = (typeof PERP_ASSETS)[number];

/** Strategies that produce long/flat/short signals from candles. Only these can run on perps. */
export const SIGNAL_STRATEGY_NAMES = ["ma_cross", "rsi", "bollinger", "donchian"] as const;

export interface StrategyFile {
  strategy: StrategyName;
  market: MarketKind;
  timeframe: Timeframe;
  pollIntervalSec: number;
  spot: {
    tokenMint: string;
    /** Binance symbol used for candles and grid prices, e.g. JUPUSDT. */
    candleSymbol: string;
    positionSizeSol: number;
    slippageBps: number;
  };
  perps: {
    asset: PerpAsset;
    collateralUsd: number;
    leverage: number;
    allowShort: boolean;
    slippageBps: number;
  };
  risk: {
    /** Price move in % that closes a position in profit. 0 disables. */
    takeProfitPct: number;
    /** Price move in % against the position that closes it. Required (> 0) on perps; 0 disables on spot. */
    stopLossPct: number;
    maxTradesPerDay: number;
    cooldownSec: number;
  };
  params: {
    grid: { levels: number; lookbackCandles: number; padPct: number; slotSizeSol: number; rerange: boolean };
    ma_cross: { fast: number; slow: number };
    rsi: { period: number; lower: number; upper: number };
    bollinger: { n: number; k: number };
    donchian: { n: number; exit: number };
    dca: { intervalHours: number; amountSol: number; maxBuys: number };
    price_trigger: { buyPrice: number; priceUnit: "SOL" | "USDC" };
  };
}

export const DEFAULT_STRATEGY: StrategyFile = {
  strategy: "grid",
  market: "spot",
  timeframe: "1h",
  pollIntervalSec: 30,
  spot: {
    tokenMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    candleSymbol: "JUPUSDT",
    positionSizeSol: 0.01,
    slippageBps: 100,
  },
  perps: { asset: "SOL", collateralUsd: 10, leverage: 2, allowShort: true, slippageBps: 200 },
  risk: { takeProfitPct: 0, stopLossPct: 10, maxTradesPerDay: 20, cooldownSec: 60 },
  params: {
    grid: { levels: 16, lookbackCandles: 720, padPct: 5, slotSizeSol: 0.005, rerange: true },
    ma_cross: { fast: 20, slow: 50 },
    rsi: { period: 14, lower: 30, upper: 70 },
    bollinger: { n: 20, k: 2 },
    donchian: { n: 20, exit: 10 },
    dca: { intervalHours: 168, amountSol: 0.005, maxBuys: 10 },
    price_trigger: { buyPrice: 0.2, priceUnit: "USDC" },
  },
};

/** Field specs drive both validation and the dashboard form. */
export interface FieldSpec {
  path: string;
  label: string;
  type: "number" | "boolean" | "string" | "select";
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options?: readonly string[];
  help?: string;
}

export const FIELD_SPECS: FieldSpec[] = [
  { path: "strategy", label: "Strategy", type: "select", options: STRATEGY_NAMES },
  { path: "market", label: "Market", type: "select", options: ["spot", "perps"] },
  { path: "timeframe", label: "Candle timeframe", type: "select", options: TIMEFRAMES },
  { path: "pollIntervalSec", label: "Poll interval (s)", type: "number", min: 5, max: 3600, integer: true },
  { path: "spot.tokenMint", label: "Spot token mint", type: "string" },
  { path: "spot.candleSymbol", label: "Spot candle symbol (Binance)", type: "string", help: "e.g. JUPUSDT" },
  { path: "spot.positionSizeSol", label: "Spot position size (SOL)", type: "number", min: 0.0001, max: 10, step: 0.0001 },
  { path: "spot.slippageBps", label: "Spot slippage (bps)", type: "number", min: 1, max: 1000, integer: true },
  { path: "perps.asset", label: "Perp asset", type: "select", options: PERP_ASSETS },
  { path: "perps.collateralUsd", label: "Perp collateral (USD)", type: "number", min: JUPITER_MIN_PERP_COLLATERAL_USD, max: HARD_MAX_PERP_COLLATERAL_USD, step: 1 },
  { path: "perps.leverage", label: "Perp leverage", type: "number", min: 1.1, max: HARD_MAX_LEVERAGE, step: 0.1 },
  { path: "perps.allowShort", label: "Allow shorts", type: "boolean" },
  { path: "perps.slippageBps", label: "Perp slippage (bps)", type: "number", min: 1, max: 1000, integer: true },
  { path: "risk.takeProfitPct", label: "Take profit (% price move, 0 = off)", type: "number", min: 0, max: 500, step: 0.1 },
  { path: "risk.stopLossPct", label: "Stop loss (% price move)", type: "number", min: 0, max: 90, step: 0.1 },
  { path: "risk.maxTradesPerDay", label: "Max trades per day", type: "number", min: 1, max: 500, integer: true },
  { path: "risk.cooldownSec", label: "Cooldown after a trade (s)", type: "number", min: 0, max: 86400, integer: true },
  { path: "params.grid.levels", label: "Grid levels", type: "number", min: 2, max: 100, integer: true },
  { path: "params.grid.lookbackCandles", label: "Grid range lookback (candles)", type: "number", min: 10, max: 1000, integer: true },
  { path: "params.grid.padPct", label: "Grid range padding (%)", type: "number", min: 0, max: 50, step: 0.5 },
  { path: "params.grid.slotSizeSol", label: "Grid slot size (SOL)", type: "number", min: 0.0001, max: 10, step: 0.0001 },
  { path: "params.grid.rerange", label: "Re-range when flat and outside range", type: "boolean" },
  { path: "params.ma_cross.fast", label: "MA fast", type: "number", min: 2, max: 500, integer: true },
  { path: "params.ma_cross.slow", label: "MA slow", type: "number", min: 3, max: 900, integer: true },
  { path: "params.rsi.period", label: "RSI period", type: "number", min: 2, max: 100, integer: true },
  { path: "params.rsi.lower", label: "RSI buy below", type: "number", min: 1, max: 50 },
  { path: "params.rsi.upper", label: "RSI sell above", type: "number", min: 50, max: 99 },
  { path: "params.bollinger.n", label: "Bollinger length", type: "number", min: 5, max: 500, integer: true },
  { path: "params.bollinger.k", label: "Bollinger std devs", type: "number", min: 0.5, max: 5, step: 0.1 },
  { path: "params.donchian.n", label: "Donchian entry length", type: "number", min: 5, max: 500, integer: true },
  { path: "params.donchian.exit", label: "Donchian exit length", type: "number", min: 2, max: 500, integer: true },
  { path: "params.dca.intervalHours", label: "DCA interval (hours)", type: "number", min: 1, max: 720 },
  { path: "params.dca.amountSol", label: "DCA amount per buy (SOL)", type: "number", min: 0.0001, max: 10, step: 0.0001 },
  { path: "params.dca.maxBuys", label: "DCA max buys", type: "number", min: 1, max: 1000, integer: true },
  { path: "params.price_trigger.buyPrice", label: "Buy at or below price", type: "number", min: 0, step: 0.000001 },
  { path: "params.price_trigger.priceUnit", label: "Price unit", type: "select", options: ["SOL", "USDC"] },
];

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys.at(-1)!] = value;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: StrategyFile;
}

export interface Caps {
  maxLeverage: number;
  maxPerpCollateralUsd: number;
}

/**
 * Validate a (possibly partial) strategy object. Missing fields take defaults. Unknown fields are
 * dropped. `caps` are the env-level perps limits, which are at most the hard caps.
 */
export function validateStrategy(input: unknown, caps: Caps): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["Strategy must be a JSON object"] };
  }
  const out: Record<string, unknown> = {};
  for (const spec of FIELD_SPECS) {
    let v = getPath(input, spec.path);
    if (v === undefined) v = getPath(DEFAULT_STRATEGY, spec.path);
    switch (spec.type) {
      case "number": {
        const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
        if (typeof n !== "number" || !Number.isFinite(n)) {
          errors.push(`${spec.path}: must be a number`);
          break;
        }
        if (spec.min !== undefined && n < spec.min) errors.push(`${spec.path}: must be >= ${spec.min}`);
        if (spec.max !== undefined && n > spec.max) errors.push(`${spec.path}: must be <= ${spec.max}`);
        if (spec.integer && !Number.isInteger(n)) errors.push(`${spec.path}: must be a whole number`);
        setPath(out, spec.path, n);
        break;
      }
      case "boolean": {
        const b = v === "true" ? true : v === "false" ? false : v;
        if (typeof b !== "boolean") errors.push(`${spec.path}: must be true or false`);
        setPath(out, spec.path, b);
        break;
      }
      case "select": {
        if (typeof v !== "string" || !spec.options!.includes(v)) {
          errors.push(`${spec.path}: must be one of ${spec.options!.join(", ")}`);
        }
        setPath(out, spec.path, v);
        break;
      }
      case "string": {
        if (typeof v !== "string" || v.trim() === "") errors.push(`${spec.path}: required`);
        setPath(out, spec.path, typeof v === "string" ? v.trim() : v);
        break;
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const s = out as unknown as StrategyFile;

  // Cross-field rules.
  try {
    new PublicKey(s.spot.tokenMint);
    if (s.spot.tokenMint === WSOL_MINT) errors.push("spot.tokenMint: cannot be SOL itself");
  } catch {
    errors.push("spot.tokenMint: not a valid Solana address");
  }
  if (!/^[A-Z0-9]{2,20}$/.test(s.spot.candleSymbol)) errors.push("spot.candleSymbol: use a Binance symbol like JUPUSDT");
  if (s.params.ma_cross.fast >= s.params.ma_cross.slow) errors.push("params.ma_cross: fast must be smaller than slow");
  if (s.params.rsi.lower >= s.params.rsi.upper) errors.push("params.rsi: lower must be below upper");
  if (s.params.donchian.exit > s.params.donchian.n) errors.push("params.donchian: exit must be <= entry length");
  if (s.strategy === "price_trigger" && s.params.price_trigger.buyPrice <= 0) {
    errors.push("params.price_trigger.buyPrice: must be > 0");
  }

  if (s.market === "perps") {
    if (!(SIGNAL_STRATEGY_NAMES as readonly string[]).includes(s.strategy)) {
      errors.push(`market perps: only ${SIGNAL_STRATEGY_NAMES.join(", ")} can run on perps`);
    }
    if (s.perps.leverage > caps.maxLeverage) {
      errors.push(`perps.leverage: ${s.perps.leverage} is above MAX_LEVERAGE ${caps.maxLeverage} (hard cap ${HARD_MAX_LEVERAGE})`);
    }
    if (s.perps.collateralUsd > caps.maxPerpCollateralUsd) {
      errors.push(`perps.collateralUsd: ${s.perps.collateralUsd} is above MAX_PERP_COLLATERAL_USD ${caps.maxPerpCollateralUsd}`);
    }
    if (!(s.risk.stopLossPct > 0)) errors.push("risk.stopLossPct: a stop loss is mandatory on perps");
    // The stop must trigger well before liquidation (roughly 100/leverage % against the position).
    const liqMovePct = 100 / s.perps.leverage;
    if (s.risk.stopLossPct > liqMovePct * 0.7) {
      errors.push(
        `risk.stopLossPct: ${s.risk.stopLossPct}% is too close to liquidation at ${s.perps.leverage}x ` +
          `(max ${(liqMovePct * 0.7).toFixed(1)}%)`,
      );
    }
  }
  if (s.strategy === "grid" && s.market !== "spot") errors.push("grid runs on spot only");
  if (s.strategy === "dca" && s.market !== "spot") errors.push("dca runs on spot only");

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: s };
}

export function strategyPath(): string {
  return resolve(PROJECT_ROOT, process.env.STRATEGY_FILE?.trim() || "strategy.json");
}

export function loadStrategy(caps: Caps): StrategyFile {
  const path = strategyPath();
  const raw: unknown = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  const res = validateStrategy(raw, caps);
  if (!res.ok) throw new Error(`Invalid ${path}:\n- ${res.errors.join("\n- ")}`);
  return res.value!;
}

export function saveStrategy(s: StrategyFile): void {
  const path = strategyPath();
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, path);
}
