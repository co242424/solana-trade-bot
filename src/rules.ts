/** Pure trading rules used by the engine. No I/O here, so they are easy to test. */

export type Dir = 1 | -1;

/** Price move in % in the position's favor. */
export function movePct(dir: Dir, entry: number, price: number): number {
  return dir * (price / entry - 1) * 100;
}

const EPS = 1e-9;

/** "stop_loss" | "take_profit" | null. Percentages are price moves; 0 disables a side. */
export function riskExit(
  dir: Dir,
  entry: number,
  price: number,
  takeProfitPct: number,
  stopLossPct: number,
): "stop_loss" | "take_profit" | null {
  const m = movePct(dir, entry, price);
  if (stopLossPct > 0 && m <= -stopLossPct + EPS) return "stop_loss";
  if (takeProfitPct > 0 && m >= takeProfitPct - EPS) return "take_profit";
  return null;
}

export type SignalAction =
  | { kind: "hold"; reason: string }
  | { kind: "close"; reason: string; block: boolean }
  | { kind: "open"; dir: Dir; reason: string };

/**
 * Decide what to do with one position given the latest signal.
 * - signal: -1/0/1 from a strategy, or null when the strategy has no exit opinion (price trigger).
 * - blocked: direction blocked after a risk exit until the signal leaves it (prevents instant re-entry).
 */
export function signalStep(args: {
  position: { dir: Dir; entry: number } | null;
  price: number;
  signal: -1 | 0 | 1 | null;
  allowShort: boolean;
  takeProfitPct: number;
  stopLossPct: number;
  blocked: -1 | 0 | 1;
  canOpen: boolean;
}): SignalAction {
  const { position, price, allowShort } = args;
  const signal = args.signal === -1 && !allowShort ? 0 : args.signal;
  if (position) {
    const exit = riskExit(position.dir, position.entry, price, args.takeProfitPct, args.stopLossPct);
    if (exit) return { kind: "close", reason: exit, block: true };
    if (signal !== null && signal !== position.dir) return { kind: "close", reason: "signal", block: false };
    return { kind: "hold", reason: "in_position" };
  }
  if (signal === null || signal === 0) return { kind: "hold", reason: "no_entry_signal" };
  if (signal === args.blocked) return { kind: "hold", reason: "blocked_after_risk_exit" };
  if (!args.canOpen) return { kind: "hold", reason: "limit_or_cooldown" };
  return { kind: "open", dir: signal, reason: "signal" };
}

export interface GridSlot {
  holding: boolean;
  armed: boolean;
  amountRaw: string;
  spentLamports: string;
  boughtAt: number;
}

export interface GridState {
  symbol: string;
  lo: number;
  hi: number;
  levels: number[];
  slots: GridSlot[];
  halted: boolean;
}

export function makeGrid(symbol: string, low: number, high: number, levels: number, padPct: number, price: number): GridState {
  const lo = low * (1 - padPct / 100);
  const hi = high * (1 + padPct / 100);
  const lv = Array.from({ length: levels + 1 }, (_, k) => lo + ((hi - lo) * k) / levels);
  return {
    symbol,
    lo,
    hi,
    levels: lv,
    slots: Array.from({ length: levels }, (_, k) => ({
      holding: false,
      // Only levels below the current price are armed; a buy limit above market would be a fake fill.
      armed: lv[k]! < price,
      amountRaw: "0",
      spentLamports: "0",
      boughtAt: 0,
    })),
    halted: false,
  };
}

export type GridAction =
  | { kind: "none"; reason: string }
  | { kind: "buy"; slot: number }
  | { kind: "sell"; slot: number }
  | { kind: "stop_all" }
  | { kind: "rerange" };

/**
 * One grid decision for the current price. At most one action per tick.
 * Mutates `armed` flags (a slot re-arms once price is above its buy level).
 */
export function gridStep(
  g: GridState,
  price: number,
  opts: { stopLossPct: number; rerange: boolean; canBuy: boolean },
): GridAction {
  if (g.halted) return { kind: "none", reason: "halted_after_stop" };
  const holding = g.slots.some((s) => s.holding);
  if (opts.stopLossPct > 0 && holding && price < g.lo * (1 - opts.stopLossPct / 100)) return { kind: "stop_all" };
  if (!holding && opts.rerange && (price < g.lo || price > g.hi)) return { kind: "rerange" };

  g.slots.forEach((s, k) => {
    if (!s.holding && price > g.levels[k]!) s.armed = true;
  });
  for (let k = g.slots.length - 1; k >= 0; k--) {
    const s = g.slots[k]!;
    if (s.holding && price >= g.levels[k + 1]!) return { kind: "sell", slot: k };
  }
  if (!opts.canBuy) return { kind: "none", reason: "limit_or_cooldown" };
  // Buy the highest armed level at or above the price (the level just crossed).
  for (let k = g.slots.length - 1; k >= 0; k--) {
    const s = g.slots[k]!;
    if (!s.holding && s.armed && price <= g.levels[k]!) return { kind: "buy", slot: k };
  }
  return { kind: "none", reason: price < g.lo || price > g.hi ? "outside_range" : "no_level_crossed" };
}
