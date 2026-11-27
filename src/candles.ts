/** Public market data from Binance (no key). Used for signals only; execution happens on Jupiter. */

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

const BASE = "https://api.binance.com/api/v3";
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export function assertSymbol(symbol: string): void {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`Invalid market symbol: ${symbol}`);
}

async function getJson(url: string): Promise<unknown> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      last = new Error(`Binance HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status === 400) break; // bad symbol or interval, retrying will not help
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw last ?? new Error("Binance request failed");
}

/** The most recent CLOSED candles (the still-forming candle is dropped). */
export async function fetchRecentCandles(
  symbol: string,
  timeframe: string,
  limit = 300,
): Promise<Candle[]> {
  assertSymbol(symbol);
  if (!(timeframe in INTERVAL_MS)) throw new Error(`Invalid timeframe: ${timeframe}`);
  const rows = (await getJson(
    `${BASE}/klines?symbol=${symbol}&interval=${timeframe}&limit=${Math.min(limit + 1, 1000)}`,
  )) as unknown[][];
  const now = Date.now();
  return rows
    .filter((k) => Number(k[6]) < now)
    .map((k) => ({
      t: Number(k[0]),
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: Number(k[5]),
    }));
}

export async function fetchLastPrice(symbol: string): Promise<number> {
  assertSymbol(symbol);
  const body = (await getJson(`${BASE}/ticker/price?symbol=${symbol}`)) as { price?: string };
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Bad ticker price for ${symbol}`);
  return price;
}
