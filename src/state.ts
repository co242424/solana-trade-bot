import fs from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.js";
import type { Position } from "./strategy.js";

const STATE_DIR = resolve(PROJECT_ROOT, "state");

/** Paper positions (dry run) and real positions never share a file. */
function stateFile(dryRun: boolean): string {
  return resolve(STATE_DIR, dryRun ? "position.dry.json" : "position.live.json");
}

export function loadPosition(dryRun: boolean): Position | null {
  const file = stateFile(dryRun);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Position | null;
  return parsed && parsed.amountRaw ? parsed : null;
}

/** Atomic write: temp file then rename, so a crash cannot leave half a file. */
export function savePosition(dryRun: boolean, position: Position | null): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFile(dryRun);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(position, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
