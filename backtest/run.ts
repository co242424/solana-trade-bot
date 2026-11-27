import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCandles, INTERVAL_MS, type Candle } from "./data.js";
import {
  INIT,
  costs,
  metrics,
  runBuyHold,
  runDca,
  runGrid,
  runSignals,
  type GridParams,
  type Metrics,
  type RunResult,
} from "./engine.js";
import { SIGNAL_STRATEGIES, describe, type Params } from "./strategies.js";

// Full report goes to backtest/output/ (git-ignored). Override with BACKTEST_OUT.
const OUT =
  process.env.BACKTEST_OUT ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "output", "backtest-results.txt");

interface Dataset {
  label: string;
  symbol: string;
  interval: "1h" | "15m";
  days: number; // fetched, includes the 30-day warmup
}

const DATASETS: Dataset[] = [
  { label: "SOL 1h (~1y)", symbol: "SOLUSDT", interval: "1h", days: 395 },
  { label: "JUP 1h (~1y)", symbol: "JUPUSDT", interval: "1h", days: 395 },
  { label: "SOL 15m (~3mo)", symbol: "SOLUSDT", interval: "15m", days: 120 },
  { label: "JUP 15m (~3mo)", symbol: "JUPUSDT", interval: "15m", days: 120 },
];

interface Row {
  name: string;
  params: string;
  m: Metrics;
}

const lines: string[] = [];
const out = (s = "") => {
  lines.push(s);
  console.log(s);
};

const f = (x: number, d = 1) => (Number.isNaN(x) ? "-" : x === Infinity ? "inf" : x.toFixed(d));

function table(rows: Row[], extraHeader = false): void {
  const head = ["Strategy", "Params", "Ret%", "CAGR%", "Win%", "Trades", "MaxDD%", "PF", "Sharpe", "Expo%"];
  const body = rows.map((r) => [
    r.name,
    r.params,
    f(r.m.totalReturnPct),
    f(r.m.cagrPct, 0),
    f(r.m.winRatePct, 0),
    String(r.m.trades),
    f(r.m.maxDdPct),
    f(r.m.profitFactor, 2),
    f(r.m.sharpe, 2),
    f(r.m.exposurePct, 0),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  out(fmt(head));
  out(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) out(fmt(b));
  void extraHeader;
}

type Variant = { key: string; label: string; short: boolean; strat: (typeof SIGNAL_STRATEGIES)[number] };
const VARIANTS: Variant[] = SIGNAL_STRATEGIES.flatMap((s) => [
  { key: `${s.name} (long)`, label: `${s.name} (long)`, short: false, strat: s },
  { key: `${s.name} (long/short)`, label: `${s.name} (long/short)`, short: true, strat: s },
]);

const GRID_DEFAULT = { levels: 16, padPct: 0.05 };
const GRID_TUNE = [8, 16, 32].flatMap((levels) => [0, 0.05].map((padPct) => ({ levels, padPct })));

// Aggregates across datasets
const fullSharpe = new Map<string, number[]>();
const fullRank = new Map<string, number[]>();
const oosRank = new Map<string, number[]>();
const oosTunedRet = new Map<string, number[]>();
const oosSharpeAll = new Map<string, number[]>();
const beatBhOosSharpe = new Map<string, number>();
const beatBhOosRet = new Map<string, number>();
const positiveOos = new Map<string, number>();
const push = (m: Map<string, number[]>, k: string, v: number) => m.set(k, [...(m.get(k) ?? []), v]);
const inc = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

async function main(): Promise<void> {
  out("SOLANA STRATEGY BACKTEST (spot, historical Binance klines)");
  out(`Generated: ${new Date().toISOString()}`);
  out("");
  out("SETUP");
  out(`- Data: real Binance spot klines (api.binance.com), only closed candles. SOL/USDT and JUP/USDT used as proxies for SOL/USDC and JUP/USDC.`);
  out(`- Costs: ${(costs.fee * 100).toFixed(1)}% fee + ${(costs.slip * 100).toFixed(1)}% slippage per side (about 0.4% per round trip). Starting capital ${INIT} USD, all-in per position, 1x, no leverage.`);
  out("- No lookahead: a signal is computed from candle i's close and executed at candle i+1's open. Indicators are causal.");
  out("- Every strategy ends in cash at the last close (exit costs included). Buy-and-hold pays entry and exit costs too.");
  out("- Short variants: 1x short on spot-like prices, no funding payments, no liquidation, no borrow cost. Real perps would add funding and liquidation risk.");
  out("- DCA: equal weekly buys that together commit the whole capital over the window; idle cash earns nothing. 'Trades' are weekly buys; win% = share of buys above the final exit price.");
  out("- Grid: long-only spot grid, range = trailing 30-day low/high (data before the start), re-ranged weekly if price left the range. Limit fills assumed at the level (or the open on a gap), with the same costs; a slot cannot buy and sell in the same candle.");
  out("- Out-of-sample: first 70% of each test window used to tune a few params per strategy (best Sharpe-ish, min 5 trades); last 30% used only to test. Defaults are also shown.");
  out("- CAGR% annualizes the window return. For the 3-month windows it is extrapolated and not a forecast; use Ret% and Sharpe there.");
  out("- Columns: Ret% total return, Win% share of closed round trips with profit, PF profit factor (gross win / gross loss), Sharpe annualized from per-candle equity returns (rf=0), Expo% share of time in the market.");
  out("");

  for (const ds of DATASETS) {
    const candles: Candle[] = await loadCandles(ds.symbol, ds.interval, ds.days);
    const barMs = INTERVAL_MS[ds.interval]!;
    const barsPerDay = 86_400_000 / barMs;
    const W = Math.round(30 * barsPerDay);
    const n = candles.length;
    const isEnd = W + Math.floor((n - W) * 0.7);
    const gridBase: Omit<GridParams, "levels" | "padPct"> = {
      lookbackBars: W,
      rerangeBars: Math.round(7 * barsPerDay),
    };
    const date = (i: number) => new Date(candles[i]!.t).toISOString().slice(0, 10);

    out("=".repeat(100));
    out(`${ds.label}: ${ds.symbol} ${ds.interval}, ${n} candles, ${date(0)} to ${date(n - 1)}`);
    out(`Tested window: ${date(W)} to ${date(n - 1)} (first 30 days are indicator warmup). Price ${candles[W]!.o} -> ${candles[n - 1]!.c}.`);
    out(`In-sample (tune): ${date(W)} to ${date(isEnd - 1)}. Out-of-sample (test): ${date(isEnd)} to ${date(n - 1)}.`);
    out("");

    const evalVariant = (v: Variant, p: Params, s: number, e: number): RunResult =>
      runSignals(candles, v.strat.fn(candles, p, v.short), s, e);
    const evalGrid = (g: { levels: number; padPct: number }, s: number, e: number): RunResult =>
      runGrid(candles, s, e, { ...gridBase, ...g });

    const runAll = (s: number, e: number, tuned: Map<string, Params | { levels: number; padPct: number }> | null): Row[] => {
      const rows: Row[] = [];
      rows.push({ name: "Buy & hold", params: "-", m: metrics(runBuyHold(candles, s, e), barMs) });
      rows.push({ name: "DCA weekly", params: "-", m: metrics(runDca(candles, s, e), barMs) });
      const gp = (tuned?.get("Grid") as { levels: number; padPct: number } | undefined) ?? GRID_DEFAULT;
      rows.push({
        name: "Grid",
        params: `levels=${gp.levels},pad=${gp.padPct}`,
        m: metrics(evalGrid(gp, s, e), barMs),
      });
      for (const v of VARIANTS) {
        const p = (tuned?.get(v.key) as Params | undefined) ?? v.strat.defaults;
        rows.push({ name: v.label, params: describe(p), m: metrics(evalVariant(v, p, s, e), barMs) });
      }
      return rows;
    };

    // ---- Full window, default parameters (no tuning at all) ----
    out(`A) FULL WINDOW, DEFAULT PARAMS (no tuning), sorted by Sharpe`);
    const full = runAll(W, n, null).sort((a, b) => b.m.sharpe - a.m.sharpe);
    table(full);
    full.forEach((r, i) => {
      push(fullRank, r.name, i + 1);
      push(fullSharpe, r.name, r.m.sharpe);
    });
    out("");

    // ---- Tuning on in-sample ----
    const tuned = new Map<string, Params | { levels: number; padPct: number }>();
    const isRows: Row[] = [];
    for (const v of VARIANTS) {
      let best: { p: Params; sharpe: number } | null = null;
      for (const p of v.strat.tuneGrid) {
        const m = metrics(evalVariant(v, p, W, isEnd), barMs);
        if (m.trades < 5) continue;
        if (!best || m.sharpe > best.sharpe) best = { p, sharpe: m.sharpe };
      }
      const chosen = best?.p ?? v.strat.defaults;
      tuned.set(v.key, chosen);
      isRows.push({ name: v.label, params: describe(chosen), m: metrics(evalVariant(v, chosen, W, isEnd), barMs) });
    }
    {
      let best: { g: { levels: number; padPct: number }; sharpe: number } | null = null;
      for (const g of GRID_TUNE) {
        const m = metrics(evalGrid(g, W, isEnd), barMs);
        if (m.trades < 5) continue;
        if (!best || m.sharpe > best.sharpe) best = { g, sharpe: m.sharpe };
      }
      const g = best?.g ?? GRID_DEFAULT;
      tuned.set("Grid", g);
      isRows.push({ name: "Grid", params: `levels=${g.levels},pad=${g.padPct}`, m: metrics(evalGrid(g, W, isEnd), barMs) });
    }
    out(`B) IN-SAMPLE (first 70%) with the params the tuning picked`);
    table([{ name: "Buy & hold", params: "-", m: metrics(runBuyHold(candles, W, isEnd), barMs) }, ...isRows].sort((a, b) => b.m.sharpe - a.m.sharpe));
    out("");

    // ---- Out-of-sample ----
    out(`C) OUT-OF-SAMPLE (last 30%), params FIXED from the in-sample tuning, sorted by Sharpe`);
    const oosTuned = runAll(isEnd, n, tuned).sort((a, b) => b.m.sharpe - a.m.sharpe);
    table(oosTuned);
    out("");
    out(`D) OUT-OF-SAMPLE with DEFAULT params (for comparison), sorted by Sharpe`);
    const oosDef = runAll(isEnd, n, null).sort((a, b) => b.m.sharpe - a.m.sharpe);
    table(oosDef);
    out("");

    // ---- E) cost sensitivity: same full-window default run with zero costs ----
    {
      const net = full;
      const saved = { ...costs };
      costs.fee = 0;
      costs.slip = 0;
      const gross = runAll(W, n, null);
      costs.fee = saved.fee;
      costs.slip = saved.slip;
      out(`E) COST DRAG: full window, default params, zero cost vs 0.2% per side (Ret% / trades)`);
      const w = Math.max(...net.map((r) => r.name.length));
      out("Strategy".padEnd(w) + "  Gross Ret%  Net Ret%  Cost drag (pts)  Trades");
      for (const r of net) {
        const g = gross.find((x) => x.name === r.name)!;
        out(
          r.name.padEnd(w) +
            "  " +
            f(g.m.totalReturnPct).padStart(10) +
            "  " +
            f(r.m.totalReturnPct).padStart(8) +
            "  " +
            f(g.m.totalReturnPct - r.m.totalReturnPct).padStart(15) +
            "  " +
            String(r.m.trades).padStart(6),
        );
      }
      out("");
    }

    const bh = oosTuned.find((r) => r.name === "Buy & hold")!;
    oosTuned.forEach((r, i) => {
      push(oosRank, r.name, i + 1);
      push(oosTunedRet, r.name, r.m.totalReturnPct);
      push(oosSharpeAll, r.name, r.m.sharpe);
      if (r.m.totalReturnPct > 0) inc(positiveOos, r.name);
      if (r.name !== "Buy & hold") {
        if (r.m.sharpe > bh.m.sharpe) inc(beatBhOosSharpe, r.name);
        if (r.m.totalReturnPct > bh.m.totalReturnPct) inc(beatBhOosRet, r.name);
      }
    });
  }

  // ---- Aggregate ----
  out("=".repeat(100));
  out(`SUMMARY ACROSS ${DATASETS.length} DATASETS (SOL 1h, JUP 1h, SOL 15m, JUP 15m)`);
  out("Avg rank = average position by Sharpe (1 = best of 11 rows). 'Beats B&H' counts datasets, out of " + DATASETS.length + ".");
  out("");
  const names = ["Buy & hold", "DCA weekly", "Grid", ...VARIANTS.map((v) => v.label)];
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const summary = names.map((nm) => ({
    nm,
    fullRank: avg(fullRank.get(nm)!),
    fullSharpe: avg(fullSharpe.get(nm)!),
    oosRank: avg(oosRank.get(nm)!),
    oosSharpe: avg(oosSharpeAll.get(nm)!),
    oosRet: avg(oosTunedRet.get(nm)!),
    pos: positiveOos.get(nm) ?? 0,
    beatS: beatBhOosSharpe.get(nm) ?? 0,
    beatR: beatBhOosRet.get(nm) ?? 0,
  }));
  summary.sort((a, b) => a.oosRank - b.oosRank);
  const head = ["Strategy", "OOS avgRank", "OOS avgSharpe", "OOS avgRet%", "OOS ret>0", "OOS beats B&H Sharpe", "OOS beats B&H Ret", "Full avgRank", "Full avgSharpe"];
  const body = summary.map((s) => [
    s.nm,
    f(s.oosRank, 1),
    f(s.oosSharpe, 2),
    f(s.oosRet),
    `${s.pos}/${DATASETS.length}`,
    s.nm === "Buy & hold" ? "-" : `${s.beatS}/${DATASETS.length}`,
    s.nm === "Buy & hold" ? "-" : `${s.beatR}/${DATASETS.length}`,
    f(s.fullRank, 1),
    f(s.fullSharpe, 2),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  out("Sorted by out-of-sample average rank (tuned params):");
  out(fmt(head));
  out(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) out(fmt(b));
  out("");
  out("CAVEATS");
  out("- Few independent samples: 2 assets, one year, one market regime. A strategy that wins here may simply have matched this period.");
  out("- SOL and JUP are highly correlated crypto assets, so the 4 datasets are not 4 independent tests. 1h and 15m runs overlap in time.");
  out("- Tuning on 70% and testing on 30% is one split, not walk-forward. Rankings of close results are noise; trade counts are small for the slow strategies.");
  out("- Costs are an assumption (0.2% per side). Real slippage on a thin token like JUP can be worse, and 15m/1h fills at the next open are idealized.");
  out("- Binance USDT prices are a proxy; Jupiter on-chain execution adds priority fees, Jito tips, and rent, which are negligible only for larger trades.");
  out("- Short results ignore funding, borrow cost and liquidation; they are an upper bound for a real perp implementation.");
  out("- Sharpe uses the arithmetic mean of per-candle returns, so it can be positive even when the total return is negative for a very volatile asset (see B&H on JUP 1h). Read it together with Ret% and MaxDD%.");
  out("- Grid fills are optimistic: a limit order is assumed filled whenever price trades through the level, with no queue position or partial fills.");
  out("- Past performance does not predict future results. Nothing here is financial advice.");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\nwritten: ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
