# solana-trade-bot

A Solana trading bot in TypeScript with pluggable strategies, Jupiter spot execution, optional Jupiter Perps,
a local dashboard and an honest backtester. It runs in **dry-run mode by default**: quotes and paper fills only,
nothing is signed or sent.

It is a learning-grade tool, not a money machine. The backtest below shows that most rule-based strategies lost
money after costs over the past year. Use it only with money you can afford to lose.

## Features

- **Strategy engine** with 7 strategies, all configured in `strategy.json` or from the dashboard:
  grid (default), MA cross, RSI reversion, Bollinger bands, Donchian breakout, DCA and a price trigger.
- **Signals from Binance candles** (closed candles only, public klines API), **execution on Jupiter spot**
  (Metis swap API) or **Jupiter Perps** (SOL, ETH, BTC long/short).
- **Risk controls**: take-profit, stop-loss, max trades per day, cooldown, consecutive-error stop, SOL reserve,
  a file-based kill switch that flattens positions, and hard caps on perps leverage and collateral.
- **Local dashboard** on `127.0.0.1`: status, mode, positions, PnL, trade log, strategy editor with validation,
  start/stop/kill, and a backtest runner. No secrets are ever sent to the browser.
- **Backtester** on real Binance history with costs, no lookahead and an out-of-sample split.

## What it does not do

- No sniping of new launches, no bundling, no wash trading, no multi-wallet trading. One wallet, one market.
- No guarantee of profit, fill price, or that a transaction lands.
- Rules are checked every `pollIntervalSec` seconds, so a fast move can jump past a level or a stop
  (perps stop-losses are also placed on-chain as Jupiter TP/SL orders; spot stops are not).

## Quick start

Requires Node 20 or newer.

```bash
npm install
cp strategy.example.json strategy.json   # optional; defaults are used without it
npm run check                            # type check
npm test                                 # unit tests
npm run dashboard                        # open the printed http://127.0.0.1:8787/ URL
npm run bot                              # or run headless (dry-run unless DRY_RUN=false)
```

Headless options: `npm run bot -- --once` (one tick), `npm run bot -- --ticks 5`. Stop with Ctrl+C.
Copy `.env.example` to `.env` only when you need to change mode, RPC, caps or the dashboard port.

## Strategies

Every strategy uses the shared `risk` block (`takeProfitPct`, `stopLossPct`, `maxTradesPerDay`, `cooldownSec`).
After a TP/SL exit the bot will not re-enter in the same direction until the signal changes.
Signal strategies follow the current signal state, so starting the bot while a signal is already "long" enters right away.

| Strategy | Params | Logic | Markets |
|---|---|---|---|
| `grid` | `levels`, `lookbackCandles`, `padPct`, `slotSizeSol`, `rerange` | Range from the recent low/high of `lookbackCandles` (plus `padPct`), split into `levels` slots. Buy a slot when price falls through its level, sell it one level up. When flat and price leaves the range, it re-ranges if `rerange` is on. If price falls `stopLossPct` below the range while holding, it sells every slot and halts until restarted. | spot |
| `ma_cross` | `fast`, `slow` | Long while fast SMA > slow SMA, short (if allowed) below | spot, perps |
| `rsi` | `period`, `lower`, `upper` | Enter long when RSI < lower, exit/short when RSI > upper | spot, perps |
| `bollinger` | `n`, `k` | Long when close < lower band, exit at the middle band; short mirrored | spot, perps |
| `donchian` | `n`, `exit` | Long on an `n`-bar high breakout, exit on an `exit`-bar low; short mirrored | spot, perps |
| `dca` | `intervalHours`, `amountSol`, `maxBuys` | Buy a fixed amount every interval, up to `maxBuys`. TP/SL apply to the average entry. | spot |
| `price_trigger` | `buyPrice`, `priceUnit` (`USDC`/`SOL`) | Buy when the token price is at or below `buyPrice`, then TP/SL | spot |

Other `strategy.json` fields:

- `market`: `spot` or `perps`. `timeframe`: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. `pollIntervalSec`: 5 or more.
- `spot`: `tokenMint` (traded against SOL), `candleSymbol` (Binance symbol used for signals, e.g. `JUPUSDT`),
  `positionSizeSol`, `slippageBps`.
- `perps`: `asset` (`SOL`, `ETH`, `BTC`), `collateralUsd`, `leverage`, `allowShort`, `slippageBps`.

Validation runs on load, in the dashboard and on every save. It rejects, among others, `fast >= slow`, RSI
`lower >= upper`, perps with grid/DCA/price trigger, leverage or collateral above the caps, perps without a
stop-loss, and a stop-loss wider than 70% of the distance to liquidation (`0.7 * 100 / leverage` %).

Spot prices for signals come from Binance (USDT pairs as a proxy). Fills always use executable Jupiter quotes.

## Jupiter Perps

Live perps use Jupiter's perps API (`https://perps-api.jup.ag/v2`), the same flow the official `jup-ag/cli` uses:

1. `POST /positions/increase` returns an unsigned transaction plus a quote. The bot always requests an on-chain
   stop-loss (and take-profit if set) in the same transaction.
2. The bot checks the transaction before signing: the fee payer must be your wallet, every program must be on an
   allowlist (Jupiter Perpetuals, the Jupiter oracle, Jupiter swap, System, Token, ATA, Compute Budget, Ed25519),
   the quoted leverage must be within the cap, and the stop must sit before the liquidation price.
3. It signs and submits through `POST /transaction/execute`. Jupiter co-signs these transactions, so they cannot be
   sent through a plain RPC. Closing uses `POST /positions/decrease` the same way.

Collateral is paid in SOL. Jupiter's minimum collateral is $10.

Hard limits (in code, not just config):

| Setting | Default | Hard cap |
|---|---|---|
| `MAX_LEVERAGE` | 2 | 3 |
| `MAX_PERP_COLLATERAL_USD` | 15 | 100 (Jupiter minimum 10) |
| Stop-loss | required | at most 70% of the way to liquidation |

Live perps need **both** `DRY_RUN=false` and `ENABLE_LIVE_PERPS=true`, plus a keypair. Otherwise perps run as
**paper perps**: real Jupiter mark prices, a 0.07% fee per side, no funding and no liquidation modeling.

CLI:

```bash
npm run perps -- markets
npm run perps -- positions --pubkey <address>
npm run perps -- open --asset SOL --side long --collateral 10 --leverage 2 --sl 5 --tp 10 \
  --build-only --simulate --pubkey <address>    # builds and simulates; never signs or sends
npm run perps -- close --position <positionPubkey>
```

Without `--build-only`, `open` is a paper trade in dry-run and a live trade only with both live flags set.

Minimum funds for a tiny live perps test (about $72 per SOL, 2026-11-27): $10 collateral (about 0.138 SOL), about
0.0107 SOL position account rent (returned when the position closes), about 0.00002 SOL in fees each for open and
close, plus `MIN_SOL_RESERVE` (0.003). Roughly **0.155 SOL** in total.

## Dashboard

`npm run dashboard` serves `http://127.0.0.1:<DASHBOARD_PORT>/` (default 8787). It binds to loopback only.

- Shows mode (DRY / LIVE), running state, kill state, spot / grid / perps positions, realized PnL and the trade log.
- Strategy selector with editable params, a "validate" button and save. Saving is refused while the bot is running.
- Start, stop and kill (kill flattens open positions and writes `state/KILL`; reset it from the dashboard).
- Backtest runner: pick strategy, symbol, interval, days and params; shows full-window and last-30% results vs buy-and-hold.

Security: every API call needs a random per-run token that the server puts into the page, requests with a foreign
`Host` header are refused, and the page is served with a strict CSP and `X-Frame-Options: DENY`. The API exposes
only booleans like `hasKeypair`, never keys, the keypair path, the Jito UUID or API keys.

## Kill switch

```bash
npm run kill                  # writes state/KILL; a running bot flattens and stops on its next tick
npm run kill -- --flatten-now # also closes positions from this process (only when no bot is running)
npm run kill -- --reset       # remove the kill file
```

## Manual spot swap

```bash
npm run swap -- --side buy  --amount 0.0005      # amount in SOL
npm run swap -- --side sell --amount 12.5        # amount in tokens, or "all"
npm run swap -- --side buy --amount 0.0005 --build-only --simulate --pubkey <wallet address>
```

With `DRY_RUN=true` this only prints the quote. `--build-only` never signs or sends.

## Configuration (.env)

Strategy settings live in `strategy.json`. `.env` holds mode, connections, secrets and caps:

| Setting | Default | Meaning |
| --- | --- | --- |
| `DRY_RUN` | `true` | Anything except an explicit `false` keeps dry-run on |
| `ENABLE_LIVE_PERPS` | `false` | Required in addition to `DRY_RUN=false` for live perps |
| `MAX_LEVERAGE` | `2` | Perps leverage cap (hard cap 3) |
| `MAX_PERP_COLLATERAL_USD` | `15` | Perps collateral cap (10 to 100) |
| `MAX_CONSECUTIVE_ERRORS` | `5` | Engine stops after this many errors in a row |
| `MIN_SOL_RESERVE` | `0.003` | Live trades are refused if they would leave less SOL |
| `RPC_URL` | public mainnet RPC | Use your own RPC for anything serious |
| `KEYPAIR_PATH` | none | Keypair file (JSON byte array or base58), live mode only |
| `SEND_VIA` | `jito` | Spot sends: `jito` or `rpc` |
| `FALLBACK_TO_RPC` | `true` | Retry over RPC if Jito refuses the send |
| `JITO_TIP_LAMPORTS` | `10000` | Jito tip (minimum 1000) |
| `JITO_UUID` | none | Optional Jito UUID |
| `PRIORITY_FEE_LAMPORTS` | `10000` | Priority fee passed to Jupiter |
| `JUPITER_API_URL` / `JUPITER_API_KEY` | `lite-api.jup.ag` | Swap API endpoint and optional key |
| `PERPS_API_URL` | `perps-api.jup.ag/v2` | Perps API endpoint |
| `DASHBOARD_PORT` | `8787` | Dashboard port (always 127.0.0.1) |

## Going live

1. Run in dry-run first, with the dashboard, until the behavior makes sense.
2. Use a fresh wallet that holds only money you can afford to lose.
3. Set `KEYPAIR_PATH` and `DRY_RUN=false`. Start with tiny sizes. For perps also set `ENABLE_LIVE_PERPS=true`.
4. A first spot buy needs more SOL than the swap amount (token account rent of about 0.00204 SOL, wrapped-SOL rent
   refunded in the same transaction, network fee, priority fee and Jito tip). The bot checks this before sending.

Live state and dry-run state use separate files (`state/engine.live.json`, `state/engine.dry.json`).

## Backtest

```bash
npm run backtest     # full report into backtest/output/backtest-results.txt
```

Summary of the 2026-11-27 run (details and caveats in [backtest/RESULTS.md](backtest/RESULTS.md)):

- Costs of 0.2% per side, signal at close, fill at the next open, 70/30 in-sample / out-of-sample split,
  4 datasets (SOL and JUP, 1h over a year and 15m over 3 months).
- **Grid was the least bad**: best out-of-sample average rank, average out-of-sample Sharpe about 0, +2.2% average
  out-of-sample return. JUP 1h full year: grid +25.1% vs buy-and-hold -7.7%. SOL 1h: grid -10.5% vs -50.2%.
- **Costs destroy the high-turnover signal strategies** (MA cross, Bollinger, Donchian). RSI long/short looked strong
  in-sample and collapsed out-of-sample, a sign of overfitting.
- Caveats: one year, one bearish regime, two correlated assets, one split, optimistic grid fills, Binance prices as a
  proxy, shorts without funding or liquidation. Past results do not predict future ones.

## Safety

- `.env`, key files, `strategy.json`, `logs/` and `state/` are git-ignored. Never commit keys.
- Secrets are never logged or sent to the dashboard.
- Live mode needs an explicit `DRY_RUN=false`; live perps need a second explicit flag.
- The engine stops after `MAX_CONSECUTIVE_ERRORS` errors in a row; `maxTradesPerDay` and `cooldownSec` limit entries.

## Project layout

```
src/config.ts         env loading and hard caps
src/strategyConfig.ts strategy.json schema, defaults and validation
src/candles.ts        Binance closed candles and last price
src/indicators.ts     SMA, EMA, RSI, Bollinger, Donchian (causal)
src/signals.ts        signal functions shared with the backtester
src/rules.ts          pure TP/SL, signal and grid step functions
src/engine.ts         strategy engine: ticks, positions, kill switch
src/perps.ts          Jupiter Perps client, checks, paper and live perps
src/jupiter.ts        swap quote and swap-instructions client
src/jito.ts           keypair loading, tip account, Jito sendTransaction
src/tx.ts             transaction building and confirmation
src/trade.ts          executeSwap: dry-run or live, with balance checks
src/tradeLog.ts       logs/trades.jsonl
src/dashboard/        local HTTP server (dashboard/index.html is the page)
src/bot.ts            headless runner
src/perpsCli.ts       perps CLI
src/swap.ts           one-shot swap CLI
src/kill.ts           kill switch CLI
backtest/             backtester, runner used by the dashboard, RESULTS.md
```

## Mainnet live test (2026-11-27)

Round trip SOL -> JUP -> SOL with `npm run swap`, sent through the Jito Tokyo block engine with a tip instruction, from a small burner wallet. All transactions finalized with no errors.

| Step | Details | Transaction |
|---|---|---|
| Buy | 0.0005 SOL -> 0.148585 JUP (quote 0.148607) | [52SN6kKu...](https://solscan.io/tx/52SN6kKus6TW6HC4TjgeFw6srBMri2b3NYHH6fu6aBL9ej23fogpmmc8h1792P5nPJXbJUCQs13FKgvnB6JUKTP1) |
| Sell | 0.148585 JUP -> ~0.0004998 SOL | [4m1wQrZu...](https://solscan.io/tx/4m1wQrZu8p94kfx2KqwHkPVYSqWZ17JB6eDspkuGJ33VYZLZCpxyEeiu8E7VnygpUpirXdoMMbYMQAuJmHgkfaBU) |
| Cleanup | Close empty JUP token account, rent recovered | [eire2uc2...](https://solscan.io/tx/eire2uc2zzdVn3PfP8A1C7UzoU3j5cRVFydQn8293ytjZSTGCAJiWj3MU2bDVa5m5CTyMTZtRLxfNuapKsSJpNk) |

Net cost of the full round trip: 0.000056249 SOL (Jito tips, priority fees, network fees and slippage).

Wallet: https://solscan.io/account/6Vpc8MS89KkXBjgHipwsMkzXy1zy76BpXBahWjuF58LB

## License

MIT. Copyright (c) 2026 co242424. Not financial advice.
