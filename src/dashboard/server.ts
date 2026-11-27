import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { resolve } from "node:path";
import { PROJECT_ROOT, loadConfig } from "../config.js";
import { Engine } from "../engine.js";
import { log } from "../log.js";
import { FIELD_SPECS, loadStrategy, saveStrategy, validateStrategy, DEFAULT_STRATEGY } from "../strategyConfig.js";
import { readTrades } from "../tradeLog.js";
import { runBacktest, type BacktestRequest } from "../../backtest/runner.js";

/**
 * Local dashboard. Binds to 127.0.0.1 only. Every /api call needs the per-run token that is
 * embedded in the served page, so other websites open in the browser cannot drive the bot
 * (custom header => CORS preflight, which this server never approves). The Host header is
 * checked to block DNS-rebinding. No secrets are ever sent to the browser: the keypair stays
 * on the server and is only read for live signing.
 */

const HOST = "127.0.0.1";
const cfg = loadConfig();
const PORT = cfg.dashboardPort;
const TOKEN = randomBytes(24).toString("hex");
const engine = new Engine(cfg);
const HTML = fs.readFileSync(resolve(PROJECT_ROOT, "dashboard", "index.html"), "utf8");
const RESULTS = resolve(PROJECT_ROOT, "backtest", "RESULTS.md");
const MAX_BODY = 64 * 1024;
let backtestBusy = false;

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json"): void {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return ok({});
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new Error("Invalid JSON"));
      }
    });
    req.on("error", fail);
  });
}

function tokenOk(req: http.IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers["x-dashboard-token"] ?? ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function hostOk(req: http.IncomingMessage): boolean {
  const host = String(req.headers.host ?? "");
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (!hostOk(req)) return send(res, 421, { error: "Bad host" });

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, HTML.replace("__DASHBOARD_TOKEN__", TOKEN), "text/html");
  }
  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  if (!tokenOk(req)) return send(res, 401, { error: "Missing or wrong dashboard token" });

  const caps = { maxLeverage: cfg.maxLeverage, maxPerpCollateralUsd: cfg.maxPerpCollateralUsd };
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case "GET /api/status":
      return send(res, 200, engine.status());
    case "GET /api/trades": {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
      return send(res, 200, readTrades(limit));
    }
    case "GET /api/strategy": {
      let current: unknown;
      let error: string | undefined;
      try {
        current = loadStrategy(caps);
      } catch (e) {
        current = DEFAULT_STRATEGY;
        error = e instanceof Error ? e.message : String(e);
      }
      return send(res, 200, { strategy: current, specs: FIELD_SPECS, caps, error });
    }
    case "POST /api/strategy/validate": {
      const v = validateStrategy(await readBody(req), caps);
      return send(res, v.ok ? 200 : 400, v);
    }
    case "PUT /api/strategy": {
      if (engine.isRunning()) return send(res, 409, { ok: false, errors: ["Stop the bot before changing the strategy"] });
      const v = validateStrategy(await readBody(req), caps);
      if (!v.ok) return send(res, 400, v);
      saveStrategy(v.value!);
      log("info", "strategy_saved", { strategy: v.value!.strategy, market: v.value!.market });
      return send(res, 200, v);
    }
    case "POST /api/start":
      await engine.start();
      return send(res, 200, engine.status());
    case "POST /api/stop":
      await engine.stop("dashboard");
      return send(res, 200, engine.status());
    case "POST /api/kill": {
      const r = await engine.kill("dashboard kill switch");
      return send(res, 200, { ...r, status: engine.status() });
    }
    case "POST /api/kill/reset":
      engine.resetKill();
      return send(res, 200, engine.status());
    case "POST /api/backtest": {
      if (backtestBusy) return send(res, 429, { error: "A backtest is already running" });
      backtestBusy = true;
      try {
        return send(res, 200, await runBacktest((await readBody(req)) as BacktestRequest));
      } finally {
        backtestBusy = false;
      }
    }
    case "GET /api/backtest/summary":
      return send(res, 200, fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, "utf8") : "No summary yet.", "text/plain");
    default:
      return send(res, 404, { error: "Not found" });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", "dashboard_request_error", { path: req.url, message });
    if (!res.headersSent) send(res, 400, { error: message });
  });
});

server.listen(PORT, HOST, () => {
  log("info", "dashboard_listening", {
    url: `http://${HOST}:${PORT}/`,
    mode: cfg.dryRun ? "DRY_RUN" : "LIVE",
    note: "local only; open the URL in a browser on this machine",
  });
});

const shutdown = async () => {
  await engine.stop("dashboard shutdown");
  server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
