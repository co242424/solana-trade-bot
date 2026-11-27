import type { Candle } from "./data.js";

/** Per-side costs. Mutable only so the report can show a zero-cost comparison. */
export const costs = { fee: 0.001, slip: 0.001 };
export const INIT = 10_000;

export interface Trade {
  pnlPct: number; // net of fees and slippage, on the capital committed to the trade
}

export interface RunResult {
  equity: number[]; // equity at each bar close, length = end - start
  trades: Trade[];
  exposure: number; // share of bars with an open position
}

/** Bars per year for annualizing. */
export function barsPerYear(barMs: number): number {
  return (365 * 86_400_000) / barMs;
}

/**
 * Signal strategies: target[i] in {-1, 0, 1} is the position the strategy wants AFTER the close of
 * candle i, computed from data up to and including candle i. It is executed at the OPEN of candle i+1,
 * so there is no lookahead. Costs: buying pays price*(1+costs.slip) and a costs.fee on notional; selling/shorting
 * receives price*(1-costs.slip) minus costs.fee. 1x, no leverage, no funding payments, no liquidation.
 */
export function runSignals(
  candles: Candle[],
  target: Int8Array,
  start: number,
  end: number,
): RunResult {
  let cash = INIT;
  let units = 0; // negative = short
  let entryEquity = 0;
  const equity: number[] = [];
  const trades: Trade[] = [];
  let barsInPos = 0;

  const flatten = (price: number) => {
    if (units > 0) cash += units * price * (1 - costs.slip) * (1 - costs.fee);
    else if (units < 0) cash -= -units * price * (1 + costs.slip) * (1 + costs.fee);
    units = 0;
    trades.push({ pnlPct: cash / entryEquity - 1 });
  };
  const open = (dir: 1 | -1, price: number) => {
    entryEquity = cash;
    if (dir === 1) {
      units = cash / (price * (1 + costs.slip) * (1 + costs.fee));
      cash = 0;
    } else {
      const sellPrice = price * (1 - costs.slip);
      const u = cash / sellPrice;
      cash += u * sellPrice * (1 - costs.fee);
      units = -u;
    }
  };

  for (let i = start; i < end; i++) {
    const want = target[i - 1] ?? 0;
    const have = units > 0 ? 1 : units < 0 ? -1 : 0;
    if (want !== have) {
      const px = candles[i]!.o;
      if (have !== 0) flatten(px);
      if (want !== 0) open(want as 1 | -1, px);
    }
    if (units !== 0) barsInPos++;
    equity.push(cash + units * candles[i]!.c);
  }
  // Liquidate at the final close with costs so every strategy ends in cash.
  if (units !== 0) {
    flatten(candles[end - 1]!.c);
    equity[equity.length - 1] = cash;
  }
  return { equity, trades, exposure: barsInPos / (end - start) };
}

export function runBuyHold(candles: Candle[], start: number, end: number): RunResult {
  const units = INIT / (candles[start]!.o * (1 + costs.slip) * (1 + costs.fee));
  const equity: number[] = [];
  for (let i = start; i < end; i++) equity.push(units * candles[i]!.c);
  const final = units * candles[end - 1]!.c * (1 - costs.slip) * (1 - costs.fee);
  equity[equity.length - 1] = final;
  return { equity, trades: [{ pnlPct: final / INIT - 1 }], exposure: 1 };
}

/** Fixed-interval buys (weekly by default) of equal size that together commit INIT; idle cash earns nothing. */
export function runDca(candles: Candle[], start: number, end: number, intervalMs = 7 * 86_400_000): RunResult {
  const weekMs = intervalMs;
  const buyIdx: number[] = [];
  let next = candles[start]!.t;
  for (let i = start; i < end; i++) {
    if (candles[i]!.t >= next) {
      buyIdx.push(i);
      next += weekMs;
    }
  }
  const per = INIT / buyIdx.length;
  let cash = INIT;
  let units = 0;
  const equity: number[] = [];
  const buys = new Set(buyIdx);
  for (let i = start; i < end; i++) {
    if (buys.has(i)) {
      units += per / (candles[i]!.o * (1 + costs.slip) * (1 + costs.fee));
      cash -= per;
    }
    equity.push(cash + units * candles[i]!.c);
  }
  const final = cash + units * candles[end - 1]!.c * (1 - costs.slip) * (1 - costs.fee);
  equity[equity.length - 1] = final;
  // For DCA, "trades" are the weekly buys; per-buy outcome is judged against the final liquidation price.
  const exitPx = candles[end - 1]!.c * (1 - costs.slip) * (1 - costs.fee);
  const trades = buyIdx.map((i) => ({
    pnlPct: exitPx / (candles[i]!.o * (1 + costs.slip) * (1 + costs.fee)) - 1,
  }));
  return { equity, trades, exposure: 1 };
}

export interface GridParams {
  levels: number; // number of grid slots
  padPct: number; // widen the range by this much on each side
  lookbackBars: number; // trailing window used to set the range
  rerangeBars: number; // check for re-ranging this often
}

/**
 * Long-only spot grid. Range = trailing-window low/high (data BEFORE the start). Slot k buys at
 * level[k] and sells at level[k+1]. A buy limit only counts if price had been above it first, and a
 * slot cannot buy and sell in the same candle. Fills use the limit price (or the open on a gap), with
 * the same slippage and fee as everything else. If price leaves the range at a check point, all
 * inventory is sold at the open and a new range is set from the trailing window.
 */
export function runGrid(candles: Candle[], start: number, end: number, p: GridParams): RunResult {
  const slotCap = INIT / p.levels;
  let cash = INIT;
  let lo = 0;
  let hi = 0;
  let levels: number[] = [];
  let holding: boolean[] = [];
  let units: number[] = [];
  let boughtAt: number[] = [];
  let armed: boolean[] = [];
  const trades: Trade[] = [];
  const equity: number[] = [];
  let barsInPos = 0;

  const setRange = (i: number) => {
    const from = Math.max(0, i - p.lookbackBars);
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = from; j < i; j++) {
      mn = Math.min(mn, candles[j]!.l);
      mx = Math.max(mx, candles[j]!.h);
    }
    lo = mn * (1 - p.padPct);
    hi = mx * (1 + p.padPct);
    levels = Array.from({ length: p.levels + 1 }, (_, k) => lo + ((hi - lo) * k) / p.levels);
    holding = new Array(p.levels).fill(false);
    units = new Array(p.levels).fill(0);
    boughtAt = new Array(p.levels).fill(-1);
    const ref = candles[i - 1]!.c;
    armed = levels.slice(0, p.levels).map((lv) => lv <= ref);
  };
  const sellSlot = (k: number, px: number) => {
    const proceeds = units[k]! * px * (1 - costs.slip) * (1 - costs.fee);
    cash += proceeds;
    trades.push({ pnlPct: proceeds / slotCap - 1 });
    units[k] = 0;
    holding[k] = false;
  };

  setRange(start);
  for (let i = start; i < end; i++) {
    const c = candles[i]!;
    if (i > start && (i - start) % p.rerangeBars === 0) {
      const prev = candles[i - 1]!.c;
      if (prev < lo || prev > hi) {
        for (let k = 0; k < p.levels; k++) if (holding[k]) sellSlot(k, c.o);
        setRange(i);
      }
    }
    for (let k = 0; k < p.levels; k++) {
      // sells first, using the state at the start of the candle
      if (holding[k] && boughtAt[k]! < i && c.h > levels[k + 1]!) {
        sellSlot(k, Math.max(levels[k + 1]!, c.o));
        armed[k] = true;
      }
    }
    for (let k = 0; k < p.levels; k++) {
      if (!holding[k] && armed[k] && c.l < levels[k]!) {
        const px = Math.min(levels[k]!, c.o);
        units[k] = slotCap / (px * (1 + costs.slip) * (1 + costs.fee));
        cash -= slotCap;
        holding[k] = true;
        boughtAt[k] = i;
      } else if (!holding[k] && !armed[k] && c.h >= levels[k]!) {
        armed[k] = true;
      }
    }
    let inv = 0;
    for (let k = 0; k < p.levels; k++) inv += units[k]!;
    if (inv > 0) barsInPos++;
    equity.push(cash + inv * c.c);
  }
  for (let k = 0; k < p.levels; k++) if (holding[k]) sellSlot(k, candles[end - 1]!.c);
  equity[equity.length - 1] = cash;
  return { equity, trades, exposure: barsInPos / (end - start) };
}

export interface Metrics {
  totalReturnPct: number;
  cagrPct: number;
  winRatePct: number;
  trades: number;
  maxDdPct: number;
  profitFactor: number;
  sharpe: number;
  exposurePct: number;
}

export function metrics(r: RunResult, barMs: number): Metrics {
  const eq = r.equity;
  const n = eq.length;
  const total = eq[n - 1]! / INIT - 1;
  const days = (n * barMs) / 86_400_000;
  const cagr = 1 + total <= 0 ? -1 : (1 + total) ** (365 / days) - 1;

  let peak = INIT;
  let maxDd = 0;
  const rets: number[] = [];
  let prev = INIT;
  for (const e of eq) {
    peak = Math.max(peak, e);
    maxDd = Math.max(maxDd, 1 - e / peak);
    rets.push(e / prev - 1);
    prev = e;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const sharpe = sd === 0 ? 0 : (mean / sd) * Math.sqrt(barsPerYear(barMs));

  const wins = r.trades.filter((t) => t.pnlPct > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlPct, 0);
  const grossLoss = r.trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a - t.pnlPct, 0);
  return {
    totalReturnPct: total * 100,
    cagrPct: cagr * 100,
    winRatePct: r.trades.length ? (wins.length / r.trades.length) * 100 : NaN,
    trades: r.trades.length,
    maxDdPct: maxDd * 100,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : NaN) : grossWin / grossLoss,
    sharpe,
    exposurePct: r.exposure * 100,
  };
}
