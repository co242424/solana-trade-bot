import fs from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.js";

export type Level = "info" | "warn" | "error";

const LOG_DIR = resolve(PROJECT_ROOT, "logs");

/**
 * Print a readable line and append one JSON object per line to logs/bot-YYYY-MM-DD.jsonl.
 * Callers must never pass secrets (keys, UUIDs, URLs with credentials).
 */
export function log(
  level: Level,
  event: string,
  data: Record<string, unknown> = {},
): void {
  const now = new Date();
  const record = { ts: now.toISOString(), level, event, ...data };
  const line = JSON.stringify(record, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const out = level === "error" ? console.error : console.log;
  out(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      resolve(LOG_DIR, `bot-${now.toISOString().slice(0, 10)}.jsonl`),
      line + "\n",
    );
  } catch (err) {
    console.error(`log file write failed: ${err instanceof Error ? err.message : err}`);
  }
}
