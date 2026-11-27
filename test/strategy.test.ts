import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type Position } from "../src/strategy.js";
import { priceSolPerToken, toRaw, toUi } from "../src/pricing.js";

const params = { buyPrice: 1.0, takeProfitPct: 20, stopLossPct: 10 };
const pos: Position = {
  mint: "M",
  priceUnit: "USDC",
  entryPrice: 1.0,
  amountRaw: "1000000",
  decimals: 6,
  spentLamports: "10000000",
  openedAt: "2026-01-01T00:00:00.000Z",
  dryRun: true,
};

test("buys at or below the buy price, holds above it", () => {
  assert.equal(decide(0.99, null, params).action, "buy");
  assert.equal(decide(1.0, null, params).action, "buy");
  assert.equal(decide(1.01, null, params).action, "hold");
});

test("sells on take profit and stop loss, holds in between", () => {
  const tp = decide(1.2, pos, params);
  assert.equal(tp.action, "sell");
  assert.equal(tp.reason, "take_profit");
  const sl = decide(0.9, pos, params);
  assert.equal(sl.action, "sell");
  assert.equal(sl.reason, "stop_loss");
  assert.equal(decide(1.05, pos, params).action, "hold");
  assert.equal(decide(0.95, pos, params).action, "hold");
});

test("refuses to act on a bad price", () => {
  assert.equal(decide(0, null, params).action, "hold");
  assert.equal(decide(Number.NaN, pos, params).action, "hold");
});

test("price and amount helpers", () => {
  // 0.5 SOL buys 100 tokens (6 decimals) -> 0.005 SOL each
  assert.equal(priceSolPerToken(500_000_000n, 100_000_000n, 6), 0.005);
  assert.equal(toRaw(0.0005, 9), 500_000n);
  assert.equal(toRaw(12.5, 6), 12_500_000n);
  assert.equal(toUi(12_500_000n, 6), 12.5);
});
