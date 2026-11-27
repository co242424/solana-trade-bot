import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve everything from the project root, not from the current working directory. */
export const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
loadEnv({ path: resolve(PROJECT_ROOT, ".env") });

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Tokyo Block Engine (docs.jito.wtf, Low Latency Transaction Send). */
export const DEFAULT_BLOCK_ENGINE_URL =
  "https://tokyo.mainnet.block-engine.jito.wtf";

/** Keyless public Jupiter endpoint. Set JUPITER_API_URL + JUPITER_API_KEY to use api.jup.ag. */
export const DEFAULT_JUPITER_URL = "https://lite-api.jup.ag/swap/v1";

export type PriceUnit = "SOL" | "USDC";
export type SendVia = "jito" | "rpc";

export interface Config {
  dryRun: boolean;
  tokenMint: string;
  priceUnit: PriceUnit;
  /** Buy when the executable price is at or below this (in priceUnit per 1 token). */
  buyPrice: number | undefined;
  takeProfitPct: number;
  stopLossPct: number;
  maxPositionSol: number;
  pollIntervalSec: number;
  slippageBps: number;
  cooldownSecAfterSell: number;
  maxTrades: number;
  maxConsecutiveErrors: number;
  rpcUrl: string;
  keypairPath: string | undefined;
  sendVia: SendVia;
  fallbackToRpc: boolean;
  jitoTipLamports: number;
  jitoUuid: string | undefined;
  blockEngineUrl: string;
  priorityFeeLamports: number;
  minSolReserve: number;
  jupiterUrl: string;
  jupiterApiKey: string | undefined;
}

type Raw = Record<string, unknown>;

function readStrategyFile(): Raw {
  const path = resolve(
    PROJECT_ROOT,
    process.env.STRATEGY_FILE?.trim() || "strategy.json",
  );
  if (!fs.existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("top level must be a JSON object");
    }
    return parsed as Raw;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read strategy file ${path}: ${reason}`);
  }
}

/** Env var wins over strategy.json, which wins over the built-in default. */
function pick(file: Raw, name: string): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = file[name];
  if (fromFile === undefined || fromFile === null || fromFile === "") {
    return undefined;
  }
  return String(fromFile);
}

function num(
  file: Raw,
  name: string,
  def: number | undefined,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number | undefined {
  const raw = pick(file, name);
  if (raw === undefined) return def;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function bool(file: Raw, name: string, def: boolean): boolean {
  const raw = pick(file, name)?.toLowerCase();
  if (raw === undefined) return def;
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

export function loadConfig(): Config {
  const file = readStrategyFile();

  const priceUnit = (pick(file, "PRICE_UNIT") ?? "USDC").toUpperCase();
  if (priceUnit !== "SOL" && priceUnit !== "USDC") {
    throw new Error(`PRICE_UNIT must be SOL or USDC, got "${priceUnit}"`);
  }
  const sendVia = (pick(file, "SEND_VIA") ?? "jito").toLowerCase();
  if (sendVia !== "jito" && sendVia !== "rpc") {
    throw new Error(`SEND_VIA must be jito or rpc, got "${sendVia}"`);
  }

  return {
    // Safe default: anything other than an explicit "false" keeps dry-run on.
    dryRun: bool(file, "DRY_RUN", true),
    tokenMint: pick(file, "TOKEN_MINT") ?? "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    priceUnit,
    buyPrice: num(file, "BUY_PRICE", undefined, 0),
    takeProfitPct: num(file, "TAKE_PROFIT_PCT", 20, 0.01)!,
    stopLossPct: num(file, "STOP_LOSS_PCT", 10, 0.01, 99)!,
    maxPositionSol: num(file, "MAX_POSITION_SOL", 0.01, 0.000001, 100)!,
    pollIntervalSec: num(file, "POLL_INTERVAL_SEC", 15, 5)!,
    slippageBps: num(file, "SLIPPAGE_BPS", 100, 1, 5000)!,
    cooldownSecAfterSell: num(file, "COOLDOWN_SEC_AFTER_SELL", 60, 0)!,
    maxTrades: num(file, "MAX_TRADES", 10, 1)!,
    maxConsecutiveErrors: num(file, "MAX_CONSECUTIVE_ERRORS", 5, 1)!,
    rpcUrl: pick(file, "RPC_URL") ?? "https://api.mainnet-beta.solana.com",
    keypairPath: pick(file, "KEYPAIR_PATH"),
    sendVia,
    fallbackToRpc: bool(file, "FALLBACK_TO_RPC", true),
    jitoTipLamports: num(file, "JITO_TIP_LAMPORTS", 10_000, 1_000)!,
    jitoUuid: pick(file, "JITO_UUID"),
    blockEngineUrl: (pick(file, "BLOCK_ENGINE_URL") ?? DEFAULT_BLOCK_ENGINE_URL).replace(/\/$/, ""),
    priorityFeeLamports: num(file, "PRIORITY_FEE_LAMPORTS", 10_000, 0)!,
    minSolReserve: num(file, "MIN_SOL_RESERVE", 0.003, 0)!,
    jupiterUrl: (pick(file, "JUPITER_API_URL") ?? DEFAULT_JUPITER_URL).replace(/\/$/, ""),
    jupiterApiKey: pick(file, "JUPITER_API_KEY"),
  };
}

/** Secrets and URLs are never printed. This is what is safe to log at startup. */
export function describeConfig(cfg: Config): Record<string, unknown> {
  return {
    dryRun: cfg.dryRun,
    tokenMint: cfg.tokenMint,
    priceUnit: cfg.priceUnit,
    buyPrice: cfg.buyPrice,
    takeProfitPct: cfg.takeProfitPct,
    stopLossPct: cfg.stopLossPct,
    maxPositionSol: cfg.maxPositionSol,
    pollIntervalSec: cfg.pollIntervalSec,
    slippageBps: cfg.slippageBps,
    sendVia: cfg.sendVia,
    fallbackToRpc: cfg.fallbackToRpc,
    jitoTipLamports: cfg.jitoTipLamports,
    hasJitoUuid: Boolean(cfg.jitoUuid),
    hasKeypair: Boolean(cfg.keypairPath),
  };
}
