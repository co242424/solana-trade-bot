import { PublicKey } from "@solana/web3.js";
import { describeConfig, LAMPORTS_PER_SOL, loadConfig, WSOL_MINT, type Config } from "./config.js";
import { getMintDecimals, getTokenBalanceRaw, makeConnection } from "./chain.js";
import { loadKeypair } from "./jito.js";
import { log } from "./log.js";
import { sampleBuyPrice, sampleSellPrice } from "./market.js";
import { toUi } from "./pricing.js";
import { loadPosition, savePosition } from "./state.js";
import { decide, type Position } from "./strategy.js";
import { executeSwap } from "./trade.js";

const once = process.argv.includes("--once");
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  log("info", "stop_requested", { note: "finishing the current tick, then exiting" });
});
process.on("SIGTERM", () => {
  stopping = true;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.buyPrice === undefined) {
    throw new Error("BUY_PRICE is required (set it in .env or strategy.json).");
  }
  if (cfg.tokenMint === WSOL_MINT) {
    throw new Error("TOKEN_MINT cannot be SOL itself.");
  }
  new PublicKey(cfg.tokenMint); // validates the base58 mint early

  const connection = makeConnection(cfg.rpcUrl);
  const decimals = await getMintDecimals(connection, cfg.tokenMint);
  const wallet = (() => {
    let cached: ReturnType<typeof loadKeypair> | undefined;
    return () => (cached ??= loadKeypair(cfg.keypairPath));
  })();
  if (!cfg.dryRun) wallet(); // fail fast if the key is unreadable

  log("info", "bot_start", {
    ...describeConfig(cfg),
    decimals,
    mode: cfg.dryRun ? "DRY_RUN (no signing, no sending)" : "LIVE (real funds)",
    wallet: cfg.dryRun ? undefined : wallet().publicKey.toBase58(),
  });

  let trades = 0;
  let errors = 0;
  let cooldownUntil = 0;

  while (!stopping) {
    try {
      const done = await tick(cfg, connection, decimals, wallet, cooldownUntil);
      errors = 0;
      if (done.traded) trades++;
      if (done.sold) cooldownUntil = Date.now() + cfg.cooldownSecAfterSell * 1000;
      if (trades >= cfg.maxTrades) {
        log("warn", "max_trades_reached", { trades, maxTrades: cfg.maxTrades });
        break;
      }
    } catch (err) {
      errors++;
      log("error", "tick_error", {
        message: err instanceof Error ? err.message : String(err),
        consecutiveErrors: errors,
      });
      if (errors >= cfg.maxConsecutiveErrors) {
        log("error", "too_many_errors_exiting", { errors });
        process.exitCode = 1;
        break;
      }
    }
    if (once) break;
    for (let i = 0; i < cfg.pollIntervalSec * 2 && !stopping; i++) await sleep(500);
  }
  log("info", "bot_stop", { trades });
}

async function tick(
  cfg: Config,
  connection: ReturnType<typeof makeConnection>,
  decimals: number,
  wallet: () => ReturnType<typeof loadKeypair>,
  cooldownUntil: number,
): Promise<{ traded: boolean; sold: boolean }> {
  let position = loadPosition(cfg.dryRun);

  if (position && (position.mint !== cfg.tokenMint || position.priceUnit !== cfg.priceUnit)) {
    throw new Error(
      "State file holds a position for a different mint or price unit. " +
        "Close it first or delete the state file on purpose.",
    );
  }

  // Live mode: if the wallet no longer holds the token (e.g. sold by hand), drop the stale state.
  if (position && !cfg.dryRun) {
    const held = await getTokenBalanceRaw(connection, wallet().publicKey, position.mint);
    if (held.raw === 0n) {
      log("warn", "position_missing_from_wallet", { note: "clearing stale state" });
      savePosition(cfg.dryRun, null);
      position = null;
    } else if (held.raw < BigInt(position.amountRaw)) {
      position = { ...position, amountRaw: held.raw.toString() };
      savePosition(cfg.dryRun, position);
    }
  }

  if (!position) {
    if (Date.now() < cooldownUntil) {
      log("info", "cooldown", { secondsLeft: Math.ceil((cooldownUntil - Date.now()) / 1000) });
      return { traded: false, sold: false };
    }
    const sample = await sampleBuyPrice(cfg, decimals);
    const d = decide(sample.price, null, {
      buyPrice: cfg.buyPrice!,
      takeProfitPct: cfg.takeProfitPct,
      stopLossPct: cfg.stopLossPct,
    });
    log("info", "tick", {
      state: "flat",
      price: sample.price,
      unit: cfg.priceUnit,
      priceSol: sample.priceSol,
      solUsd: sample.solUsd,
      buyPrice: cfg.buyPrice,
      decision: d.action,
      reason: d.reason,
    });
    if (d.action !== "buy") return { traded: false, sold: false };

    const lamports = BigInt(Math.round(cfg.maxPositionSol * LAMPORTS_PER_SOL));
    const res = await executeSwap(
      cfg,
      connection,
      { side: "buy", tokenMint: cfg.tokenMint, amountRaw: lamports },
      wallet,
    );
    const amountRaw = res.tokenDeltaRaw && res.tokenDeltaRaw > 0n ? res.tokenDeltaRaw : res.expectedOutRaw;
    const priceSol = Number(res.inAmountRaw) / LAMPORTS_PER_SOL / toUi(amountRaw, decimals);
    const entryPrice = cfg.priceUnit === "SOL" ? priceSol : priceSol * (sample.solUsd ?? 0);
    const opened: Position = {
      mint: cfg.tokenMint,
      priceUnit: cfg.priceUnit,
      entryPrice,
      amountRaw: amountRaw.toString(),
      decimals,
      spentLamports: res.inAmountRaw.toString(),
      openedAt: new Date().toISOString(),
      entrySignature: res.signature,
      dryRun: cfg.dryRun,
    };
    savePosition(cfg.dryRun, opened);
    log("info", cfg.dryRun ? "paper_position_opened" : "position_opened", {
      entryPrice,
      unit: cfg.priceUnit,
      tokens: toUi(amountRaw, decimals),
      spentSol: Number(res.inAmountRaw) / LAMPORTS_PER_SOL,
      signature: res.signature,
    });
    return { traded: true, sold: false };
  }

  const sample = await sampleSellPrice(cfg, position);
  const d = decide(sample.price, position, {
    buyPrice: cfg.buyPrice!,
    takeProfitPct: cfg.takeProfitPct,
    stopLossPct: cfg.stopLossPct,
  });
  log("info", "tick", {
    state: "holding",
    price: sample.price,
    unit: cfg.priceUnit,
    entryPrice: position.entryPrice,
    pnlPct: d.action === "buy" ? undefined : d.pnlPct,
    takeProfitPct: cfg.takeProfitPct,
    stopLossPct: cfg.stopLossPct,
    decision: d.action,
    reason: d.reason,
  });
  if (d.action !== "sell") return { traded: false, sold: false };

  const res = await executeSwap(
    cfg,
    connection,
    { side: "sell", tokenMint: position.mint, amountRaw: BigInt(position.amountRaw) },
    wallet,
  );
  const gotSol = Number(res.expectedOutRaw) / LAMPORTS_PER_SOL;
  const spentSol = Number(position.spentLamports) / LAMPORTS_PER_SOL;
  savePosition(cfg.dryRun, null);
  log("info", cfg.dryRun ? "paper_position_closed" : "position_closed", {
    reason: d.reason,
    pnlPct: d.pnlPct,
    spentSol,
    expectedReceivedSol: gotSol,
    signature: res.signature,
    note: "received amount is the quote estimate; fees and tip are not included",
  });
  return { traded: true, sold: true };
}


main().catch((err) => {
  log("error", "fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
