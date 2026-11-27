import { INTERVAL_MS, loadCandles } from "./data.js";
import { metrics, runBuyHold, runDca, runGrid, runSignals, type Metrics } from "./engine.js";
import { SIGNALS, warmupBars } from "../src/signals.js";

/** Limits so a dashboard request cannot ask for an unreasonable amount of data. */
const MAX_DAYS: Record<string, number> = { "5m": 30, "15m": 120, "1h": 400, "4h": 400, "1d": 400 };

export interface BacktestRequest {
  strategy: string;
  symbol: string;
  interval: string;
  days: number;
  allowShort?: boolean;
  params?: Record<string, number | boolean | string>;
}

export interface BacktestResponse {
  symbol: string;
  interval: string;
  from: string;
  to: string;
  candles: number;
  costs: string;
  full: { strategy: Metrics; buyHold: Metrics };
  outOfSample: { from: string; strategy: Metrics; buyHold: Metrics };
  note: string;
}

export async function runBacktest(req: BacktestRequest): Promise<BacktestResponse> {
  if (!(req.interval in MAX_DAYS)) throw new Error(`interval must be one of ${Object.keys(MAX_DAYS).join(", ")}`);
  if (!/^[A-Z0-9]{2,20}$/.test(req.symbol)) throw new Error("symbol must be a Binance symbol like SOLUSDT");
  const days = Math.round(Number(req.days));
  if (!(days >= 7 && days <= MAX_DAYS[req.interval]!)) {
    throw new Error(`days must be 7-${MAX_DAYS[req.interval]} for ${req.interval}`);
  }
  const barMs = INTERVAL_MS[req.interval]!;
  const barsPerDay = 86_400_000 / barMs;
  const warmDays = 30;
  const candles = await loadCandles(req.symbol, req.interval, days + warmDays);
  const W = Math.min(Math.round(warmDays * barsPerDay), Math.floor(candles.length / 3));
  const n = candles.length;
  if (n - W < 50) throw new Error("Not enough candles for this window");
  const oosStart = W + Math.floor((n - W) * 0.7);
  const p = (req.params ?? {}) as Record<string, number>;

  const run = (s: number, e: number) => {
    switch (req.strategy) {
      case "grid":
        return runGrid(candles, s, e, {
          levels: Number(p.levels ?? 16),
          padPct: Number(p.padPct ?? 5) / 100,
          lookbackBars: Number(p.lookbackCandles ?? W),
          rerangeBars: Math.round(7 * barsPerDay),
        });
      case "dca":
        return runDca(candles, s, e, Number(p.intervalHours ?? 168) * 3_600_000);
      case "ma_cross":
      case "rsi":
      case "bollinger":
      case "donchian": {
        const name = req.strategy;
        if (warmupBars(name, p) > W) throw new Error("Indicator lookback is longer than the 30-day warmup");
        return runSignals(candles, SIGNALS[name](candles, p, Boolean(req.allowShort)), s, e);
      }
      default:
        throw new Error(`Backtest not available for ${req.strategy} (price_trigger depends on a fixed price level)`);
    }
  };
  const date = (i: number) => new Date(candles[i]!.t).toISOString().slice(0, 10);
  return {
    symbol: req.symbol,
    interval: req.interval,
    from: date(W),
    to: date(n - 1),
    candles: n - W,
    costs: "0.1% fee + 0.1% slippage per side",
    full: { strategy: metrics(run(W, n), barMs), buyHold: metrics(runBuyHold(candles, W, n), barMs) },
    outOfSample: {
      from: date(oosStart),
      strategy: metrics(run(oosStart, n), barMs),
      buyHold: metrics(runBuyHold(candles, oosStart, n), barMs),
    },
    note: "Parameters are used as given (not tuned here). The last-30% slice is shown separately; a good full-window result that fails on it is a warning sign. Past results do not predict future ones.",
  };
}
