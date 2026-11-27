import { parseArgs } from "node:util";
import { PublicKey } from "@solana/web3.js";
import { loadConfig } from "./config.js";
import { makeConnection } from "./chain.js";
import { loadKeypair } from "./jito.js";
import { log } from "./log.js";
import { LivePerps, PaperPerps, PerpsApi, PERP_ASSET_MINTS, type OpenRequest } from "./perps.js";
import { PERP_ASSETS, type PerpAsset } from "./strategyConfig.js";

const USAGE = `Usage:
  npm run perps -- markets
  npm run perps -- positions [--pubkey <address>]
  npm run perps -- open --asset SOL --side long --collateral 10 --leverage 2 --sl 5 [--tp 10]
        [--build-only [--simulate] [--pubkey <address>]]
  npm run perps -- close --position <positionPubkey>
Dry-run (default) opens a paper position. Live needs DRY_RUN=false AND ENABLE_LIVE_PERPS=true.
--build-only builds the Jupiter Perps transaction and checks it, never signs or sends.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      asset: { type: "string", default: "SOL" },
      side: { type: "string" },
      collateral: { type: "string" },
      leverage: { type: "string" },
      sl: { type: "string" },
      tp: { type: "string", default: "0" },
      slippage: { type: "string", default: "200" },
      "build-only": { type: "boolean", default: false },
      simulate: { type: "boolean", default: false },
      pubkey: { type: "string" },
      position: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }
  const cfg = loadConfig();
  const api = new PerpsApi(cfg.perpsApiUrl);
  const connection = makeConnection(cfg.rpcUrl);
  const wallet = () => loadKeypair(cfg.keypairPath);

  if (cmd === "markets") {
    for (const a of PERP_ASSETS) console.log(`${a}: $${await api.markPrice(a)}  (mint ${PERP_ASSET_MINTS[a]})`);
    return;
  }
  if (cmd === "positions") {
    const owner = values.pubkey ?? wallet().publicKey.toBase58();
    console.log(JSON.stringify(await api.positions(owner), null, 2));
    return;
  }
  if (cmd === "open") {
    const asset = values.asset!.toUpperCase() as PerpAsset;
    if (!PERP_ASSETS.includes(asset)) throw new Error(`--asset must be one of ${PERP_ASSETS.join(", ")}`);
    if (values.side !== "long" && values.side !== "short") throw new Error("--side must be long or short");
    const req: OpenRequest = {
      asset,
      side: values.side,
      collateralUsd: Number(values.collateral),
      leverage: Number(values.leverage),
      stopLossPct: Number(values.sl),
      takeProfitPct: Number(values.tp),
      slippageBps: Number(values.slippage),
    };
    if (values["build-only"]) {
      const owner = values.pubkey ? new PublicKey(values.pubkey) : wallet().publicKey;
      const venue = new LivePerps(api, cfg, connection, wallet);
      const b = await venue.buildOpen(req, owner);
      const q = b.res.quote;
      log("info", "perp_build_only", {
        note: "built and checked, NOT signed and NOT sent",
        payer: owner.toBase58(),
        positionPubkey: b.res.positionPubkey,
        markPrice: b.mark,
        entryPriceUsd: Number(q.averagePriceUsd) / 1e6,
        sizeUsd: Number(q.sizeUsdDelta) / 1e6,
        leverage: Number(q.leverage),
        liquidationPriceUsd: Number(q.liquidationPriceUsd) / 1e6,
        stopLossPrice: b.stopLossPrice,
        takeProfitPrice: b.takeProfitPrice,
        openFeeUsd: Number(q.openFeeUsd) / 1e6,
        collateralLamports: b.lamports,
        txFeeLamports: b.res.txMetadata.transactionFeeLamports,
        accountRentLamports: b.res.txMetadata.accountRentLamports,
        serializedBytes: b.tx.serialize().length,
        requiredSigners: b.tx.message.staticAccountKeys.slice(0, b.tx.message.header.numRequiredSignatures).map((k) => k.toBase58()),
      });
      if (values.simulate) {
        const sim = await connection.simulateTransaction(b.tx, { sigVerify: false, replaceRecentBlockhash: true });
        log("info", "perp_simulation", {
          err: sim.value.err ? JSON.stringify(sim.value.err) : null,
          unitsConsumed: sim.value.unitsConsumed,
          instructions: sim.value.logs?.filter((l) => l.includes("Instruction:")),
        });
      }
      return;
    }
    if (cfg.dryRun) {
      const pos = await new PaperPerps(api, cfg).open(req);
      console.log(JSON.stringify({ note: "DRY_RUN: paper position only, nothing sent", ...pos }, null, 2));
      return;
    }
    if (!cfg.enableLivePerps) throw new Error("Live perps disabled: set ENABLE_LIVE_PERPS=true");
    const pos = await new LivePerps(api, cfg, connection, wallet).open(req);
    console.log(JSON.stringify(pos, null, 2));
    return;
  }
  if (cmd === "close") {
    if (cfg.dryRun || !cfg.enableLivePerps) throw new Error("close is live only (DRY_RUN=false and ENABLE_LIVE_PERPS=true)");
    if (!values.position) throw new Error("--position is required");
    const venue = new LivePerps(api, cfg, connection, wallet);
    const open = (await venue.openPositions()).find((p) => p.positionPubkey === values.position);
    if (!open) throw new Error("Position not found for this wallet");
    console.log(JSON.stringify(await venue.close(open), null, 2));
    return;
  }
  console.log(USAGE);
}

main().catch((e) => {
  log("error", "fatal", { message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
