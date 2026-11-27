import type { Candle } from "./candles.js";
import { prevHighest, prevLowest, rollingStd, rsi, sma } from "./indicators.js";

/**
 * Signal strategies shared by the live bot and the backtest. Each returns, for every candle i,
 * the position wanted after candle i closes (-1 short, 0 flat, 1 long), using only data up to i.
 * The live bot acts on the value of the last CLOSED candle.
 */
export type SignalParams = Record<string, number>;
export type SignalFn = (c: Candle[], p: SignalParams, allowShort: boolean) => Int8Array;

export const maCross: SignalFn = (c, p, allowShort) => {
  const close = c.map((x) => x.c);
  const f = sma(close, p.fast!);
  const s = sma(close, p.slow!);
  const out = new Int8Array(c.length);
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(s[i]!)) continue;
    out[i] = f[i]! > s[i]! ? 1 : allowShort ? -1 : 0;
  }
  return out;
};

export const rsiReversion: SignalFn = (c, p, allowShort) => {
  const r = rsi(c.map((x) => x.c), p.period!);
  const out = new Int8Array(c.length);
  let pos = 0;
  for (let i = 0; i < c.length; i++) {
    const v = r[i]!;
    if (!Number.isNaN(v)) {
      if (v < p.lower!) pos = 1;
      else if (v > p.upper!) pos = allowShort ? -1 : 0;
    }
    out[i] = pos;
  }
  return out;
};

export const bollinger: SignalFn = (c, p, allowShort) => {
  const close = c.map((x) => x.c);
  const mid = sma(close, p.n!);
  const sd = rollingStd(close, p.n!);
  const out = new Int8Array(c.length);
  let pos = 0;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(mid[i]!)) continue;
    const lower = mid[i]! - p.k! * sd[i]!;
    const upper = mid[i]! + p.k! * sd[i]!;
    if (pos === 0) {
      if (close[i]! < lower) pos = 1;
      else if (allowShort && close[i]! > upper) pos = -1;
    } else if (pos === 1 && close[i]! >= mid[i]!) {
      pos = 0;
    } else if (pos === -1 && close[i]! <= mid[i]!) {
      pos = 0;
    }
    out[i] = pos;
  }
  return out;
};

export const donchian: SignalFn = (c, p, allowShort) => {
  const hh = prevHighest(c.map((x) => x.h), p.n!);
  const ll = prevLowest(c.map((x) => x.l), p.n!);
  const xl = prevLowest(c.map((x) => x.l), p.exit!);
  const xh = prevHighest(c.map((x) => x.h), p.exit!);
  const out = new Int8Array(c.length);
  let pos = 0;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(hh[i]!)) continue;
    const close = c[i]!.c;
    if (pos === 0) {
      if (close > hh[i]!) pos = 1;
      else if (allowShort && close < ll[i]!) pos = -1;
    } else if (pos === 1 && close < xl[i]!) {
      pos = allowShort && close < ll[i]! ? -1 : 0;
    } else if (pos === -1 && close > xh[i]!) {
      pos = close > hh[i]! ? 1 : 0;
    }
    out[i] = pos;
  }
  return out;
};

export const SIGNALS = {
  ma_cross: maCross,
  rsi: rsiReversion,
  bollinger,
  donchian,
} as const;

/** Candles needed before a signal is meaningful. */
export function warmupBars(name: keyof typeof SIGNALS, p: SignalParams): number {
  switch (name) {
    case "ma_cross":
      return p.slow! + 1;
    case "rsi":
      return p.period! * 3;
    case "bollinger":
      return p.n! + 1;
    case "donchian":
      return p.n! + 1;
  }
}
