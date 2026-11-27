import {
  LAMPORTS_PER_SOL,
  USDC_MINT,
  WSOL_MINT,
  type Config,
} from "./config.js";
import { getQuote } from "./jupiter.js";
import { priceSolPerToken } from "./pricing.js";
import type { Position } from "./strategy.js";

export interface PriceSample {
  /** Price in cfg.priceUnit per 1 token. */
  price: number;
  priceSol: number;
  /** USD per SOL used for the conversion (only when priceUnit is USDC). */
  solUsd?: number;
  priceImpactPct: string;
}

async function solUsd(cfg: Config): Promise<number> {
  const q = await getQuote(cfg, {
    inputMint: WSOL_MINT,
    outputMint: USDC_MINT,
    amountRaw: BigInt(LAMPORTS_PER_SOL),
  });
  return Number(q.outAmount) / 1e6;
}

async function finish(
  cfg: Config,
  priceSol: number,
  priceImpactPct: string,
): Promise<PriceSample> {
  if (cfg.priceUnit === "SOL") return { price: priceSol, priceSol, priceImpactPct };
  const usd = await solUsd(cfg);
  return { price: priceSol * usd, priceSol, solUsd: usd, priceImpactPct };
}

/** Executable buy price: what MAX_POSITION_SOL would actually buy right now. */
export async function sampleBuyPrice(
  cfg: Config,
  decimals: number,
): Promise<PriceSample> {
  const lamports = BigInt(Math.round(cfg.maxPositionSol * LAMPORTS_PER_SOL));
  const q = await getQuote(cfg, {
    inputMint: WSOL_MINT,
    outputMint: cfg.tokenMint,
    amountRaw: lamports,
  });
  const priceSol = priceSolPerToken(lamports, BigInt(q.outAmount), decimals);
  return finish(cfg, priceSol, q.priceImpactPct);
}

/** Executable sell price for the whole open position. */
export async function sampleSellPrice(
  cfg: Config,
  position: Position,
): Promise<PriceSample> {
  const q = await getQuote(cfg, {
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amountRaw: BigInt(position.amountRaw),
  });
  const priceSol = priceSolPerToken(
    BigInt(q.outAmount),
    BigInt(position.amountRaw),
    position.decimals,
  );
  return finish(cfg, priceSol, q.priceImpactPct);
}
