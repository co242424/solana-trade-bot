import fs from "node:fs";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "./config.js";

const FETCH_TIMEOUT_MS = 15_000;

type JsonRpcBody<T> = {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

/** Load a keypair from a JSON byte array file or a base58 file. The key is never logged. */
export function loadKeypair(path: string | undefined): Keypair {
  if (!path) {
    throw new Error("KEYPAIR_PATH is required for live trading (set it in .env).");
  }
  if (!fs.existsSync(path)) {
    throw new Error(`Keypair file not found: ${path}`);
  }
  const raw = fs.readFileSync(path, "utf8").trim();
  if (!raw) throw new Error(`Keypair file is empty: ${path}`);
  try {
    if (raw.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read keypair at ${path}: ${reason}`);
  }
}

function jitoUrl(cfg: Config, path: string): string {
  const url = new URL(`${cfg.blockEngineUrl}${path}`);
  if (cfg.jitoUuid) url.searchParams.set("uuid", cfg.jitoUuid);
  return url.toString();
}

async function jitoRpc<T>(
  cfg: Config,
  path: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.jitoUuid) headers["x-jito-auth"] = cfg.jitoUuid;

  const res = await fetch(jitoUrl(cfg, path), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const raw = await res.text();
  let body: JsonRpcBody<T> | undefined;
  try {
    body = raw ? (JSON.parse(raw) as JsonRpcBody<T>) : undefined;
  } catch {
    body = undefined;
  }
  if (res.status === 429) {
    throw new Error(
      `Jito ${method} rate-limited (429). Default limit is 1 request/sec per IP without a UUID.`,
    );
  }
  if (!res.ok || body?.error || body?.result === undefined) {
    const detail = body?.error
      ? `${body.error.code} ${body.error.message}`
      : raw.slice(0, 300) || `${res.status} ${res.statusText}`;
    throw new Error(`Jito ${method} failed (${res.status}): ${detail}`);
  }
  return body.result;
}

export async function getTipAccount(cfg: Config): Promise<PublicKey> {
  const accounts = await jitoRpc<string[]>(
    cfg,
    "/api/v1/getTipAccounts",
    "getTipAccounts",
    [],
  );
  if (!accounts.length) throw new Error("getTipAccounts returned an empty list");
  return new PublicKey(accounts[Math.floor(Math.random() * accounts.length)]!);
}

export function tipInstruction(
  payer: PublicKey,
  tipAccount: PublicKey,
  lamports: number,
) {
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccount,
    lamports,
  });
}

/** Send one serialized, signed transaction through the block engine. Returns the signature. */
export async function sendViaJito(
  cfg: Config,
  serialized: Uint8Array,
): Promise<string> {
  const encoded = Buffer.from(serialized).toString("base64");
  return jitoRpc<string>(cfg, "/api/v1/transactions", "sendTransaction", [
    encoded,
    { encoding: "base64" },
  ]);
}
