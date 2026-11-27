import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { HARD_MAX_LEVERAGE } from "../src/config.js";
import { assertPerpCaps, inspectPerpsTx, perpPnlUsd, stopAndTarget, type OpenRequest } from "../src/perps.js";
import { DEFAULT_STRATEGY, validateStrategy } from "../src/strategyConfig.js";

const caps = { maxLeverage: 2, maxPerpCollateralUsd: 15 };
const req: OpenRequest = { asset: "SOL", side: "long", collateralUsd: 10, leverage: 2, stopLossPct: 5, takeProfitPct: 0, slippageBps: 200 };

test("perp caps: leverage, collateral and a mandatory stop loss", () => {
  assert.doesNotThrow(() => assertPerpCaps(caps, req));
  assert.throws(() => assertPerpCaps(caps, { ...req, leverage: 2.5 }), /Leverage/);
  // even if the env cap were set higher, the hard cap of 3 wins
  assert.throws(() => assertPerpCaps({ maxLeverage: 10, maxPerpCollateralUsd: 15 }, { ...req, leverage: 4 }), /hard cap 3/);
  assert.equal(HARD_MAX_LEVERAGE, 3);
  assert.throws(() => assertPerpCaps(caps, { ...req, collateralUsd: 20 }), /Collateral/);
  assert.throws(() => assertPerpCaps(caps, { ...req, collateralUsd: 5 }), /Collateral/);
  assert.throws(() => assertPerpCaps(caps, { ...req, stopLossPct: 0 }), /mandatory/);
  assert.throws(() => assertPerpCaps(caps, { ...req, stopLossPct: 60 }), /liquidation/);
});

test("stop and target prices sit on the right side of entry", () => {
  const l = stopAndTarget(100, "long", 5, 10);
  assert.equal(l.stopLossPrice, 95);
  assert.ok(Math.abs(l.takeProfitPrice! - 110) < 1e-9);
  const s = stopAndTarget(100, "short", 5, 0);
  assert.equal(s.stopLossPrice, 105);
  assert.equal(s.takeProfitPrice, null);
  const pos = { side: "short", entryPrice: 100, sizeUsd: 20 } as Parameters<typeof perpPnlUsd>[0];
  assert.equal(perpPnlUsd(pos, 90), 2);
});

test("strategy validation: defaults are valid, bad values are rejected", () => {
  assert.equal(validateStrategy({}, caps).ok, true);
  assert.equal(validateStrategy(DEFAULT_STRATEGY, caps).ok, true);
  const bad = (patch: Record<string, unknown>) => validateStrategy({ ...DEFAULT_STRATEGY, ...patch }, caps);
  assert.equal(bad({ strategy: "martingale" }).ok, false);
  assert.equal(bad({ timeframe: "7m" }).ok, false);
  assert.equal(bad({ pollIntervalSec: 1 }).ok, false);
  assert.equal(bad({ params: { ...DEFAULT_STRATEGY.params, ma_cross: { fast: 50, slow: 20 } } }).ok, false);
  assert.equal(bad({ spot: { ...DEFAULT_STRATEGY.spot, tokenMint: "not-a-mint" } }).ok, false);
});

test("strategy validation: perps rules", () => {
  const perps = (patch: Record<string, unknown> = {}, risk: Record<string, unknown> = {}) =>
    validateStrategy({ ...DEFAULT_STRATEGY, strategy: "ma_cross", market: "perps", ...patch, risk: { ...DEFAULT_STRATEGY.risk, ...risk } }, caps);
  assert.equal(perps().ok, true);
  assert.equal(perps({ strategy: "grid" }).ok, false, "grid is spot only");
  assert.equal(perps({}, { stopLossPct: 0 }).ok, false, "stop loss mandatory");
  assert.equal(perps({}, { stopLossPct: 40 }).ok, false, "stop too close to liquidation at 2x");
  assert.equal(perps({ perps: { ...DEFAULT_STRATEGY.perps, leverage: 3 } }).ok, false, "above env cap 2");
  assert.equal(perps({ perps: { ...DEFAULT_STRATEGY.perps, leverage: 5 } }).ok, false, "above hard cap");
  assert.equal(perps({ perps: { ...DEFAULT_STRATEGY.perps, collateralUsd: 50 } }).ok, false, "above collateral cap");
});

test("API-built perps transactions are inspected before signing", () => {
  const me = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const build = (payer: PublicKey, programTransfer = true) => {
    const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 1 });
    if (!programTransfer) ix.programId = new PublicKey("Stake11111111111111111111111111111111111111");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: [ix] }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
  };
  assert.doesNotThrow(() => inspectPerpsTx(build(me), me));
  assert.throws(() => inspectPerpsTx(build(other), me), /fee payer/);
  assert.throws(() => inspectPerpsTx(build(me, false), me), /unexpected program/);
});
