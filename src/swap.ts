import { parseArgs } from "node:util";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { loadConfig, WSOL_MINT } from "./config.js";
import { getMintDecimals, makeConnection } from "./chain.js";
import { getQuote } from "./jupiter.js";
import { getTipAccount, loadKeypair } from "./jito.js";
import { log } from "./log.js";
import { toRaw, toUi } from "./pricing.js";
import { executeSwap } from "./trade.js";
import { buildSwapTransaction } from "./tx.js";
import { getTokenBalanceRaw } from "./chain.js";

const USAGE = `Usage:
  npm run swap -- --side buy  --amount 0.0005          (amount in SOL)
  npm run swap -- --side sell --amount 12.5            (amount in tokens, or "all")
Options:
  --mint <mint>        token mint (default: TOKEN_MINT)
  --dry-run            force a dry run even if DRY_RUN=false
  --build-only         build the transaction and print its size, never sign or send
  --simulate           with --build-only: also run RPC simulateTransaction (no signature check)
  --pubkey <address>   with --build-only: wallet address to build for (default: KEYPAIR_PATH's address)
DRY_RUN=true (default) only prints the quote. Live sending needs DRY_RUN=false.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      side: { type: "string" },
      amount: { type: "string" },
      mint: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "build-only": { type: "boolean", default: false },
      simulate: { type: "boolean", default: false },
      pubkey: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.side || !values.amount) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  if (values.side !== "buy" && values.side !== "sell") {
    throw new Error('--side must be "buy" or "sell"');
  }
  const side = values.side;

  const cfg = loadConfig();
  if (values["dry-run"] || values["build-only"]) cfg.dryRun = true;
  const tokenMint = values.mint ?? cfg.tokenMint;
  new PublicKey(tokenMint);
  if (tokenMint === WSOL_MINT) throw new Error("The token mint cannot be SOL itself.");

  const connection = makeConnection(cfg.rpcUrl);
  const decimals = await getMintDecimals(connection, tokenMint);

  let amountRaw: bigint;
  if (side === "buy") {
    amountRaw = toRaw(Number(values.amount), 9);
  } else if (values.amount === "all") {
    const owner = values.pubkey
      ? new PublicKey(values.pubkey)
      : loadKeypair(cfg.keypairPath).publicKey;
    amountRaw = (await getTokenBalanceRaw(connection, owner, tokenMint)).raw;
    if (amountRaw === 0n) throw new Error("Wallet holds none of this token.");
  } else {
    amountRaw = toRaw(Number(values.amount), decimals);
  }

  if (values["build-only"]) {
    const owner = values.pubkey
      ? new PublicKey(values.pubkey)
      : loadKeypair(cfg.keypairPath).publicKey;
    const quote = await getQuote(cfg, {
      inputMint: side === "buy" ? WSOL_MINT : tokenMint,
      outputMint: side === "buy" ? tokenMint : WSOL_MINT,
      amountRaw,
    });
    const tip = cfg.sendVia === "jito"
      ? { account: await getTipAccount(cfg), lamports: cfg.jitoTipLamports }
      : undefined;
    const built = await buildSwapTransaction(cfg, connection, quote, owner, tip);
    const bytes = built.tx.serialize();
    // Round-trip proves the bytes are a valid versioned transaction.
    VersionedTransaction.deserialize(bytes);
    log("info", "build_only", {
      note: "built but NOT signed and NOT sent",
      payer: owner.toBase58(),
      side,
      inAmount: quote.inAmount,
      expectedOut: quote.outAmount,
      serializedBytes: bytes.length,
      maxBytes: 1232,
      instructions: built.instructionCount,
      programs: built.programIds,
      tipLamports: tip?.lamports,
    });
    if (values.simulate) {
      const sim = await connection.simulateTransaction(built.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      });
      log("info", "simulation", {
        err: sim.value.err ? JSON.stringify(sim.value.err) : null,
        unitsConsumed: sim.value.unitsConsumed,
        lastLogs: sim.value.logs?.slice(-4),
      });
    }
    return;
  }

  const res = await executeSwap(
    cfg,
    connection,
    { side, tokenMint, amountRaw },
    () => loadKeypair(cfg.keypairPath),
  );
  const outDecimals = side === "buy" ? decimals : 9;
  console.log(
    `${side}: in ${toUi(res.inAmountRaw, side === "buy" ? 9 : decimals)} -> expected out ${toUi(res.expectedOutRaw, outDecimals)}` +
      (res.signature ? `\nsignature: ${res.signature} (via ${res.sentVia})` : "\n(dry run, nothing sent)"),
  );
}

main().catch((err) => {
  log("error", "fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
