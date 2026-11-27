import { bollinger, donchian, maCross, rsiReversion, type SignalFn } from "../src/signals.js";

/** Backtest wrappers around the shared signal functions in src/signals.ts, plus tuning grids. */
export type Params = Record<string, number>;

export interface StrategyDef {
  name: string;
  fn: SignalFn;
  defaults: Params;
  /** Small grid of values to tune on the first 70% of the data. */
  tuneGrid: Params[];
  shortCapable: boolean;
}

function product(space: Record<string, number[]>): Params[] {
  let out: Params[] = [{}];
  for (const [k, vals] of Object.entries(space)) {
    out = out.flatMap((o) => vals.map((v) => ({ ...o, [k]: v })));
  }
  return out;
}

export const SIGNAL_STRATEGIES: StrategyDef[] = [
  {
    name: "MA cross",
    fn: maCross,
    defaults: { fast: 20, slow: 50 },
    tuneGrid: product({ fast: [10, 20, 30], slow: [50, 100, 200] }),
    shortCapable: true,
  },
  {
    name: "RSI",
    fn: rsiReversion,
    defaults: { period: 14, lower: 30, upper: 70 },
    tuneGrid: product({ period: [7, 14, 21], lower: [20, 25, 30, 35] }).map((p) => ({
      ...p,
      upper: 100 - p.lower!,
    })),
    shortCapable: true,
  },
  {
    name: "Bollinger",
    fn: bollinger,
    defaults: { n: 20, k: 2 },
    tuneGrid: product({ n: [20, 40], k: [1.5, 2, 2.5] }),
    shortCapable: true,
  },
  {
    name: "Donchian",
    fn: donchian,
    defaults: { n: 20, exit: 10 },
    tuneGrid: [20, 40, 80].map((n) => ({ n, exit: n / 2 })),
    shortCapable: true,
  },
];

export function describe(p: Params): string {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}
