import { LAMPORTS_PER_SOL } from "./config.js";

/** SOL per 1 whole token, from raw lamports and raw token units. */
export function priceSolPerToken(
  lamports: bigint,
  tokenRaw: bigint,
  tokenDecimals: number,
): number {
  if (tokenRaw <= 0n) throw new Error("Cannot price a zero token amount");
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  const tokens = Number(tokenRaw) / 10 ** tokenDecimals;
  return sol / tokens;
}

/** Convert a raw integer amount to a UI number (for logs only, never for sending). */
export function toUi(raw: bigint | string, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Convert a UI decimal amount to raw integer units without float drift for typical inputs. */
export function toRaw(ui: number, decimals: number): bigint {
  if (!Number.isFinite(ui) || ui <= 0) throw new Error(`Invalid amount: ${ui}`);
  const text = ui.toFixed(decimals);
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}
