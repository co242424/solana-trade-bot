import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Config } from "./config.js";

const FETCH_TIMEOUT_MS = 15_000;

/** Subset of the Jupiter quote response we read. The full object is passed back to /swap-instructions untouched. */
export interface Quote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo?: { label?: string } }>;
  [key: string]: unknown;
}

interface ApiInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

export interface SwapInstructions {
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  addressLookupTableAddresses: string[];
  simulationError?: { errorCode?: string; error?: string } | null;
}

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.jupiterApiKey) h["x-api-key"] = cfg.jupiterApiKey;
  return h;
}

async function request<T>(
  cfg: Config,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${cfg.jupiterUrl}${path}`, {
        ...init,
        headers: headers(cfg),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Jupiter ${path.split("?")[0]} HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Jupiter ${path.split("?")[0]} returned non-JSON: ${text.slice(0, 200)}`);
      }
      if (!res.ok || (body as { error?: unknown }).error) {
        const msg = (body as { error?: string }).error ?? res.statusText;
        throw new Error(`Jupiter ${path.split("?")[0]} error: ${msg}`);
      }
      return body as T;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Jupiter")) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("Jupiter request failed");
}

export function getQuote(
  cfg: Config,
  args: { inputMint: string; outputMint: string; amountRaw: bigint; slippageBps?: number },
): Promise<Quote> {
  const params = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amountRaw.toString(),
    slippageBps: String(args.slippageBps ?? cfg.slippageBps),
    swapMode: "ExactIn",
    restrictIntermediateTokens: "true",
  });
  return request<Quote>(cfg, `/quote?${params.toString()}`);
}

export function getSwapInstructions(
  cfg: Config,
  quote: Quote,
  userPublicKey: PublicKey,
): Promise<SwapInstructions> {
  return request<SwapInstructions>(cfg, "/swap-instructions", {
    method: "POST",
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: cfg.priorityFeeLamports,
    }),
  });
}

export function toInstruction(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}
