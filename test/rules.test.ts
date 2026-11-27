import assert from "node:assert/strict";
import { test } from "node:test";
import { gridStep, makeGrid, movePct, riskExit, signalStep } from "../src/rules.js";
import { priceSolPerToken, toRaw, toUi } from "../src/pricing.js";

const base = { allowShort: false, takeProfitPct: 20, stopLossPct: 10, blocked: 0 as const, canOpen: true };

test("risk exits use price moves in the position's direction", () => {
  assert.equal(riskExit(1, 100, 90, 20, 10), "stop_loss");
  assert.equal(riskExit(1, 100, 120, 20, 10), "take_profit");
  assert.equal(riskExit(1, 100, 105, 20, 10), null);
  assert.equal(riskExit(-1, 100, 110, 20, 10), "stop_loss");
  assert.equal(riskExit(-1, 100, 80, 20, 10), "take_profit");
  assert.equal(riskExit(1, 100, 50, 0, 0), null, "0 disables both");
  assert.ok(Math.abs(movePct(-1, 100, 95) - 5) < 1e-9);
  // Float edge: 1.2 / 1 - 1 = 0.19999999999999996
  assert.equal(riskExit(1, 1, 1.2, 20, 10), "take_profit");
});

test("signalStep opens, holds, closes on signal and on risk", () => {
  assert.deepEqual(signalStep({ ...base, position: null, price: 1, signal: 1 }).kind, "open");
  assert.equal(signalStep({ ...base, position: null, price: 1, signal: 0 }).kind, "hold");
  assert.equal(signalStep({ ...base, position: null, price: 1, signal: -1 }).kind, "hold", "no shorts on spot");
  assert.equal(signalStep({ ...base, allowShort: true, position: null, price: 1, signal: -1 }).kind, "open");
  assert.equal(signalStep({ ...base, position: { dir: 1, entry: 1 }, price: 1.05, signal: 1 }).kind, "hold");
  const flip = signalStep({ ...base, position: { dir: 1, entry: 1 }, price: 1.05, signal: 0 });
  assert.equal(flip.kind, "close");
  const sl = signalStep({ ...base, position: { dir: 1, entry: 1 }, price: 0.89, signal: 1 });
  assert.equal(sl.kind, "close");
  assert.equal(sl.kind === "close" && sl.block, true);
  // price trigger: null signal never closes by itself
  assert.equal(signalStep({ ...base, position: { dir: 1, entry: 1 }, price: 1.01, signal: null }).kind, "hold");
});

test("no re-entry right after a risk exit, and limits block entries but not exits", () => {
  assert.equal(signalStep({ ...base, blocked: 1, position: null, price: 1, signal: 1 }).kind, "hold");
  assert.equal(signalStep({ ...base, canOpen: false, position: null, price: 1, signal: 1 }).kind, "hold");
  assert.equal(signalStep({ ...base, canOpen: false, position: { dir: 1, entry: 1 }, price: 0.5, signal: 1 }).kind, "close");
});

test("grid buys on the way down and sells one level up", () => {
  const g = makeGrid("X", 90, 110, 4, 0, 105); // levels 90, 95, 100, 105, 110
  assert.deepEqual(g.levels, [90, 95, 100, 105, 110]);
  // only levels below 105 are armed at start
  assert.deepEqual(g.slots.map((s) => s.armed), [true, true, true, false]);
  const opts = { stopLossPct: 10, rerange: true, canBuy: true };
  assert.equal(gridStep(g, 104, opts).kind, "none");
  const buy = gridStep(g, 99, opts);
  assert.deepEqual(buy, { kind: "buy", slot: 2 });
  g.slots[2]!.holding = true;
  g.slots[2]!.armed = false;
  assert.equal(gridStep(g, 102, opts).kind, "none");
  assert.deepEqual(gridStep(g, 105.5, opts), { kind: "sell", slot: 2 });
  // canBuy=false still allows sells
  assert.deepEqual(gridStep(g, 106, { ...opts, canBuy: false }), { kind: "sell", slot: 2 });
});

test("grid stop loss and re-range", () => {
  const g = makeGrid("X", 90, 110, 4, 0, 100);
  g.slots[0]!.holding = true;
  assert.equal(gridStep(g, 80, { stopLossPct: 10, rerange: true, canBuy: true }).kind, "stop_all");
  g.slots[0]!.holding = false;
  assert.equal(gridStep(g, 80, { stopLossPct: 10, rerange: true, canBuy: true }).kind, "rerange");
  g.halted = true;
  assert.equal(gridStep(g, 100, { stopLossPct: 10, rerange: true, canBuy: true }).kind, "none");
});

test("price and amount helpers", () => {
  assert.equal(priceSolPerToken(500_000_000n, 100_000_000n, 6), 0.005);
  assert.equal(toRaw(0.0005, 9), 500_000n);
  assert.equal(toRaw(12.5, 6), 12_500_000n);
  assert.equal(toUi(12_500_000n, 6), 12.5);
});
