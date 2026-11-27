import { config as loadEnv } from "dotenv";
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

/** Hard limits for perps that no setting can raise. */
export const HARD_MAX_LEVERAGE = 3;
export const HARD_MAX_PERP_COLLATERAL_USD = 100;
/** Jupiter Perps rejects new positions with less than $10 collateral. */
export const JUPITER_MIN_PERP_COLLATERAL_USD = 10;
export const DEFAULT_PERPS_API_URL = "https://perps-api.jup.ag/v2";

export type SendVia = "jito" | "rpc";

export interface Config {
  dryRun: boolean;
  /** Default token for the one-shot swap CLI. The bot uses spot.tokenMint from strategy.json. */
  tokenMint: string;
  /** Default slippage for the swap CLI; the bot overrides it from strategy.json. */
  slippageBps: number;
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
  /** Perps safety caps (env only, so the dashboard cannot raise them). */
  maxLeverage: number;
  maxPerpCollateralUsd: number;
  /** Live perps need BOTH DRY_RUN=false and ENABLE_LIVE_PERPS=true. */
  enableLivePerps: boolean;
  perpsApiUrl: string;
  dashboardPort: number;
}

type Raw = Record<string, unknown>;

/** Env var wins over the built-in default. (Strategy settings live in strategy.json, see strategyConfig.ts.) */
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
  const file: Raw = {};

  const sendVia = (pick(file, "SEND_VIA") ?? "jito").toLowerCase();
  if (sendVia !== "jito" && sendVia !== "rpc") {
    throw new Error(`SEND_VIA must be jito or rpc, got "${sendVia}"`);
  }

  return {
    // Safe default: anything other than an explicit "false" keeps dry-run on.
    dryRun: bool(file, "DRY_RUN", true),
    tokenMint: pick(file, "TOKEN_MINT") ?? "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    slippageBps: num(file, "SLIPPAGE_BPS", 100, 1, 5000)!,
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
    maxLeverage: num({}, "MAX_LEVERAGE", 2, 1, HARD_MAX_LEVERAGE)!,
    maxPerpCollateralUsd: num(
      {},
      "MAX_PERP_COLLATERAL_USD",
      15,
      JUPITER_MIN_PERP_COLLATERAL_USD,
      HARD_MAX_PERP_COLLATERAL_USD,
    )!,
    enableLivePerps: bool({}, "ENABLE_LIVE_PERPS", false),
    perpsApiUrl: (process.env.PERPS_API_URL?.trim() || DEFAULT_PERPS_API_URL).replace(/\/$/, ""),
    dashboardPort: num({}, "DASHBOARD_PORT", 8787, 1024, 65535)!,
  };
}

/** Secrets and URLs are never printed. This is what is safe to log at startup. */
export function describeConfig(cfg: Config): Record<string, unknown> {
  return {
    dryRun: cfg.dryRun,
    sendVia: cfg.sendVia,
    fallbackToRpc: cfg.fallbackToRpc,
    jitoTipLamports: cfg.jitoTipLamports,
    hasJitoUuid: Boolean(cfg.jitoUuid),
    hasKeypair: Boolean(cfg.keypairPath),
    maxLeverage: cfg.maxLeverage,
    maxPerpCollateralUsd: cfg.maxPerpCollateralUsd,
    enableLivePerps: cfg.enableLivePerps,
  };
}
