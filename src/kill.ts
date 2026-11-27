import fs from "node:fs";
import { loadConfig } from "./config.js";
import { Engine, KILL_FILE } from "./engine.js";

/**
 * npm run kill                 -> write the kill file; a running bot/dashboard flattens and stops on its next tick
 * npm run kill -- --flatten-now -> also close positions from THIS process (only when no bot is running)
 * npm run kill -- --reset       -> remove the kill file so the bot can start again
 */
async function main(): Promise<void> {
  if (process.argv.includes("--reset")) {
    if (fs.existsSync(KILL_FILE)) fs.unlinkSync(KILL_FILE);
    console.log("Kill switch reset.");
    return;
  }
  const engine = new Engine(loadConfig());
  if (process.argv.includes("--flatten-now")) {
    const r = await engine.kill("cli --flatten-now");
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  fs.mkdirSync(KILL_FILE.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(KILL_FILE, `${new Date().toISOString()} cli\n`);
  console.log(`Kill file written: ${KILL_FILE}. A running bot will flatten and stop on its next tick.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
