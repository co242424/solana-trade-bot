import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INTERVAL_MS, type Candle } from "../src/candles.js";

export { INTERVAL_MS, type Candle };

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "data");
const BASE = "https://api.binance.com/api/v3/klines";


async function fetchPage(symbol: string, interval: string, startTime: number): Promise<unknown[][]> {
  const url = `${BASE}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=1000`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) return (await res.json()) as unknown[][];
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`Binance klines failed for ${symbol} ${interval}`);
}

/** Real Binance spot klines, cached as CSV. Only fully closed candles are kept. */
export async function loadCandles(symbol: string, interval: string, days: number): Promise<Candle[]> {
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new Error(`Invalid symbol: ${symbol}`);
  if (!(interval in INTERVAL_MS)) throw new Error(`Invalid interval: ${interval}`);
  const file = resolve(DIR, `${symbol}_${interval}_${days}d.csv`);
  const maxAgeMs = 6 * 60 * 60_000; // refresh cached data after 6 hours
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAgeMs) {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const [t, o, h, l, c, v] = line.split(",").map(Number);
        return { t: t!, o: o!, h: h!, l: l!, c: c!, v: v! };
      });
  }
  const ms = INTERVAL_MS[interval]!;
  const now = Date.now();
  let start = now - days * 86_400_000;
  const out: Candle[] = [];
  while (start < now) {
    const page = await fetchPage(symbol, interval, start);
    if (page.length === 0) break;
    for (const k of page) {
      const closeTime = Number(k[6]);
      if (closeTime >= now) continue; // drop the still-forming candle
      out.push({
        t: Number(k[0]),
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
      });
    }
    start = Number(page[page.length - 1]![0]) + ms;
    await new Promise((r) => setTimeout(r, 250));
  }
  // De-duplicate and validate continuity.
  const seen = new Set<number>();
  const clean = out.filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)));
  clean.sort((a, b) => a.t - b.t);
  let gaps = 0;
  for (let i = 1; i < clean.length; i++) if (clean[i]!.t - clean[i - 1]!.t !== ms) gaps++;
  if (gaps > 0) console.warn(`warning: ${symbol} ${interval} has ${gaps} gaps`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    file,
    "t,o,h,l,c,v\n" + clean.map((c) => `${c.t},${c.o},${c.h},${c.l},${c.c},${c.v}`).join("\n") + "\n",
  );
  return clean;
}
