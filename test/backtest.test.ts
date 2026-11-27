import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candle } from "../backtest/data.js";
import { INIT, costs, metrics, runBuyHold, runGrid, runSignals } from "../backtest/engine.js";
import { sma } from "../src/indicators.js";

function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    t: i * 3_600_000,
    o: i === 0 ? c : closes[i - 1]!,
    h: Math.max(c, i === 0 ? c : closes[i - 1]!) * 1.001,
    l: Math.min(c, i === 0 ? c : closes[i - 1]!) * 0.999,
    c,
    v: 1,
  }));
}

function withCosts<T>(fee: number, slip: number, fn: () => T): T {
  const saved = { ...costs };
  costs.fee = fee;
  costs.slip = slip;
  try {
    return fn();
  } finally {
    costs.fee = saved.fee;
    costs.slip = saved.slip;
  }
}

test("a strategy that never trades keeps its capital", () => {
  const c = series([10, 11, 12, 13, 14]);
  const r = runSignals(c, new Int8Array(c.length), 1, c.length);
  assert.equal(r.equity.at(-1), INIT);
  assert.equal(r.trades.length, 0);
});

test("signals execute at the NEXT candle's open, not the signal candle", () => {
  // Signal appears on candle 2 (close 12). Entry must be at candle 3's open (= close of candle 2 = 12 here),
  // so a jump visible only in candle 2's close is not captured.
  const c = series([10, 10, 20, 20, 20]);
  const t = new Int8Array(c.length);
  t[2] = 1; // wants long after seeing the 20 close
  const r = withCosts(0, 0, () => runSignals(c, t, 1, c.length));
  assert.ok(Math.abs(r.equity.at(-1)! - INIT) < 1e-6, "no profit from a move that was already over");
});

test("costs are charged on both sides", () => {
  const c = series([100, 100, 100, 100]);
  const t = new Int8Array([1, 1, 0, 0]);
  const r = withCosts(0.001, 0.001, () => runSignals(c, t, 1, c.length));
  // buy: price*(1+s), fee f; sell: price*(1-s), fee f
  const roundTrip = ((1 - 0.001) * (1 - 0.001)) / ((1 + 0.001) * (1 + 0.001));
  assert.ok(Math.abs(r.equity.at(-1)! - INIT * roundTrip) < 1e-6, `${r.equity.at(-1)} vs ${INIT * roundTrip}`);
});

test("a short profits when price falls and loses when it rises", () => {
  const down = series([100, 100, 90, 80, 70]);
  const up = series([100, 100, 110, 120, 130]);
  const t = new Int8Array([-1, -1, -1, -1, -1]);
  const rDown = withCosts(0, 0, () => runSignals(down, t, 1, down.length));
  const rUp = withCosts(0, 0, () => runSignals(up, t, 1, up.length));
  assert.ok(rDown.equity.at(-1)! > INIT);
  assert.ok(rUp.equity.at(-1)! < INIT);
});

test("buy and hold matches the closed-form return with costs", () => {
  const c = series([100, 100, 150]);
  const r = withCosts(0.001, 0.001, () => runBuyHold(c, 1, c.length));
  const expected = (INIT / (100 * 1.001 * 1.001)) * 150 * 0.999 * 0.999;
  assert.ok(Math.abs(r.equity.at(-1)! - expected) < 1e-6);
});

test("an oscillating market makes a zero-cost grid profitable", () => {
  const closes: number[] = [100];
  for (let i = 0; i < 400; i++) closes.push(100 + 8 * Math.sin(i / 6));
  const c = series(closes);
  const r = withCosts(0, 0, () =>
    runGrid(c, 100, c.length, { levels: 8, padPct: 0.02, lookbackBars: 100, rerangeBars: 24 }),
  );
  assert.ok(r.trades.length > 5);
  assert.ok(r.equity.at(-1)! > INIT);
});

test("sma and metrics basics", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  const m = metrics({ equity: [INIT * 1.1, INIT * 0.99, INIT * 1.21], trades: [{ pnlPct: 0.1 }, { pnlPct: -0.05 }], exposure: 1 }, 3_600_000);
  assert.ok(Math.abs(m.totalReturnPct - 21) < 1e-9);
  assert.ok(Math.abs(m.maxDdPct - 10) < 1e-9);
  assert.equal(m.trades, 2);
  assert.ok(Math.abs(m.profitFactor - 2) < 1e-9);
});
