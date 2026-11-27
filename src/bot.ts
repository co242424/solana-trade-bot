import { loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { log } from "./log.js";

/** Headless runner: `npm run bot` (add `-- --once` for a single tick). */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const engine = new Engine(cfg);
  const once = process.argv.includes("--once");
  const ticksArg = process.argv.indexOf("--ticks");
  const maxTicks = once ? 1 : ticksArg > 0 ? Number(process.argv[ticksArg + 1]) : Infinity;

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "signal_received", { signal: sig, note: "stopping after the current tick; positions stay open" });
    await engine.stop(sig);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (Number.isFinite(maxTicks)) {
    // Fixed number of ticks, used for tests and quick checks.
    await engine.start();
    await engine.stop("manual tick mode");
    for (let i = 0; i < maxTicks; i++) {
      await engine.tick();
      if (i < maxTicks - 1) await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(JSON.stringify(engine.status(), null, 2));
    return;
  }
  await engine.start();
}

main().catch((err) => {
  log("error", "fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
