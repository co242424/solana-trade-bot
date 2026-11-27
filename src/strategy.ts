export interface Position {
  mint: string;
  priceUnit: "SOL" | "USDC";
  /** Entry price in priceUnit per 1 token. */
  entryPrice: number;
  amountRaw: string;
  decimals: number;
  spentLamports: string;
  openedAt: string;
  entrySignature?: string;
  dryRun: boolean;
}

export interface StrategyParams {
  buyPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
}

export type Decision =
  | { action: "buy"; reason: string }
  | { action: "sell"; reason: "take_profit" | "stop_loss"; pnlPct: number }
  | { action: "hold"; reason: string; pnlPct?: number };

/**
 * Pure decision function. `price` must be the executable price for the next action:
 * the buy-quote price when flat, the sell-quote price when holding a position.
 */
export function decide(
  price: number,
  position: Position | null,
  p: StrategyParams,
): Decision {
  if (!Number.isFinite(price) || price <= 0) {
    return { action: "hold", reason: "invalid_price" };
  }
  if (!position) {
    return price <= p.buyPrice
      ? { action: "buy", reason: `price ${price} <= buy price ${p.buyPrice}` }
      : { action: "hold", reason: `price ${price} > buy price ${p.buyPrice}` };
  }
  const pnlPct = (price / position.entryPrice - 1) * 100;
  // Tiny tolerance so float error (1.2 / 1 - 1 = 0.19999999999999996) cannot miss a threshold.
  const eps = 1e-9;
  if (pnlPct >= p.takeProfitPct - eps) {
    return { action: "sell", reason: "take_profit", pnlPct };
  }
  if (pnlPct <= -p.stopLossPct + eps) {
    return { action: "sell", reason: "stop_loss", pnlPct };
  }
  return { action: "hold", reason: "in_range", pnlPct };
}
