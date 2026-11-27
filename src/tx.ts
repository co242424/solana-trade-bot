import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { getSwapInstructions, toInstruction, type Quote } from "./jupiter.js";
import { tipInstruction } from "./jito.js";

export interface BuiltSwap {
  /** Unsigned v0 transaction. Sign with the payer before sending. */
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
  instructionCount: number;
  programIds: string[];
}

async function loadLookupTables(
  connection: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  const results = await Promise.all(
    addresses.map((a) => connection.getAddressLookupTable(new PublicKey(a))),
  );
  const tables: AddressLookupTableAccount[] = [];
  results.forEach((r, i) => {
    if (!r.value) throw new Error(`Lookup table ${addresses[i]} not found`);
    tables.push(r.value);
  });
  return tables;
}

/**
 * Build a swap transaction from Jupiter's /swap-instructions, optionally with a Jito tip
 * transfer appended as the last instruction.
 */
export async function buildSwapTransaction(
  cfg: Config,
  connection: Connection,
  quote: Quote,
  payer: PublicKey,
  tip?: { account: PublicKey; lamports: number },
): Promise<BuiltSwap> {
  const ix = await getSwapInstructions(cfg, quote, payer);
  if (ix.simulationError) {
    log("warn", "jupiter_simulation_warning", {
      code: ix.simulationError.errorCode,
      error: ix.simulationError.error,
    });
  }

  const instructions: TransactionInstruction[] = [
    ...ix.computeBudgetInstructions.map(toInstruction),
    ...ix.setupInstructions.map(toInstruction),
    toInstruction(ix.swapInstruction),
    ...(ix.cleanupInstruction ? [toInstruction(ix.cleanupInstruction)] : []),
    ...ix.otherInstructions.map(toInstruction),
  ];
  if (tip) instructions.push(tipInstruction(payer, tip.account, tip.lamports));

  const [tables, bh] = await Promise.all([
    loadLookupTables(connection, ix.addressLookupTableAddresses ?? []),
    connection.getLatestBlockhash("confirmed"),
  ]);

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: bh.blockhash,
    instructions,
  }).compileToV0Message(tables);

  const tx = new VersionedTransaction(message);
  return {
    tx,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    instructionCount: instructions.length,
    programIds: [...new Set(instructions.map((i) => i.programId.toBase58()))],
  };
}

/** Poll signature status until confirmed/finalized, an on-chain error, or blockhash expiry. */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  timeoutMs = 90_000,
): Promise<"confirmed" | "failed" | "expired"> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = value[0];
    if (status) {
      if (status.err) {
        log("error", "tx_failed_onchain", { signature, err: JSON.stringify(status.err) });
        return "failed";
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return "confirmed";
      }
    }
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      // One last look: the tx may have landed right before expiry.
      const final = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const s = final.value[0];
      if (s && !s.err) return "confirmed";
      return s?.err ? "failed" : "expired";
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `Timed out waiting for ${signature}; status unknown. Check it on an explorer before retrying.`,
  );
}
