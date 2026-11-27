import fs from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.js";

const FILE = resolve(PROJECT_ROOT, "logs", "trades.jsonl");

export interface TradeRecord {
  ts: string;
  mode: "dry" | "live";
  market: "spot" | "perps";
  strategy: string;
  action: "open" | "close" | "buy" | "sell";
  side: "long" | "short";
  instrument: string;
  price: number;
  size: string;
  /** Realized PnL for closes/sells. SOL for spot, USD for perps. */
  pnl?: number;
  pnlUnit?: "SOL" | "USD";
  reason: string;
  signature?: string;
}

export function appendTrade(t: Omit<TradeRecord, "ts">): TradeRecord {
  const rec = { ts: new Date().toISOString(), ...t };
  fs.mkdirSync(resolve(PROJECT_ROOT, "logs"), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(rec) + "\n");
  return rec;
}

export function readTrades(limit = 200): TradeRecord[] {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as TradeRecord;
      } catch {
        return null;
      }
    })
    .filter((x): x is TradeRecord => x !== null)
    .reverse();
}
