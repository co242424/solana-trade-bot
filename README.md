# solana-trade-bot

A small Solana auto buy/sell bot in TypeScript. It polls [Jupiter](https://dev.jup.ag) for executable quotes on one token, buys when the price drops to a level you set, and sells on take-profit or stop-loss. It runs in **dry-run mode by default**: it logs what it would do and never signs or sends anything.

It is a learning-grade tool, not a money machine. It does not predict anything. It applies fixed price rules, and fixed rules can lose money.

## What it does

- Quotes through Jupiter's swap API (`/swap/v1/quote` and `/swap/v1/swap-instructions`). The default endpoint is the keyless `lite-api.jup.ag`; you can point it at `api.jup.ag` with an API key.
- Strategy from `.env` or `strategy.json` (env wins): target token mint, buy price (in USDC or SOL per token), take-profit %, stop-loss %, max position size in SOL, polling interval, slippage.
- Prices are executable, not mid prices. When flat, it quotes buying `MAX_POSITION_SOL` worth of the token. When holding, it quotes selling the whole position.
- Live mode signs with a local keypair and sends through the Jito block engine (Tokyo by default) with a tip, or through plain RPC. If Jito refuses the send, it can fall back to RPC once. It never resends after Jito accepted a transaction, so a swap cannot land twice.
- One open position at a time, saved to `state/` so a restart picks up where it left off. Dry-run and live positions use separate files.
- JSON log lines in `logs/bot-YYYY-MM-DD.jsonl`, also printed to the console.

## What it does not do

- No sniping of new token launches, no bundling, no wash trading, no multi-wallet trading. One wallet, one token, one position.
- No guarantee of profit, fill price, or that a transaction lands.
- Take-profit and stop-loss are checked only every `POLL_INTERVAL_SEC` seconds, so a fast move can jump past your levels.

## Quick start

Requires Node 20 or newer.

```bash
npm install
cp .env.example .env
# edit .env: TOKEN_MINT, BUY_PRICE, and the other strategy values
npm run check        # type check
npm test             # strategy and pricing unit tests
npm run bot          # dry-run loop (DRY_RUN=true is the default)
```

Try a single tick: `npm run bot -- --once`. Stop the loop with Ctrl+C.

### Manual swap

```bash
npm run swap -- --side buy  --amount 0.0005      # amount in SOL
npm run swap -- --side sell --amount 12.5        # amount in tokens, or "all"
```

With `DRY_RUN=true` this only prints the quote. To check that a live transaction can be built without sending anything:

```bash
npm run swap -- --side buy --amount 0.0005 --build-only --simulate --pubkey <wallet address>
```

`--build-only` builds the transaction, prints its size and programs, and never signs or sends. `--simulate` also runs the RPC `simulateTransaction` with signature checks off. Manual swaps do not touch the bot's position file.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `DRY_RUN` | `true` | Anything except an explicit `false` keeps dry-run on |
| `TOKEN_MINT` | JUP | Token to trade against SOL |
| `PRICE_UNIT` | `USDC` | Unit of `BUY_PRICE`: `USDC` or `SOL`, price of one token |
| `BUY_PRICE` | required | Buy when the executable price is at or below this |
| `TAKE_PROFIT_PCT` | `20` | Sell when up this much from entry |
| `STOP_LOSS_PCT` | `10` | Sell when down this much from entry |
| `MAX_POSITION_SOL` | `0.01` | Size of one position |
| `POLL_INTERVAL_SEC` | `15` | Seconds between checks (minimum 5) |
| `SLIPPAGE_BPS` | `100` | Max slippage passed to Jupiter |
| `COOLDOWN_SEC_AFTER_SELL` | `60` | Wait before buying again |
| `MAX_TRADES` | `10` | Bot exits after this many trades |
| `MAX_CONSECUTIVE_ERRORS` | `5` | Bot exits after this many errors in a row |
| `RPC_URL` | public mainnet RPC | Use your own RPC for anything serious |
| `KEYPAIR_PATH` | none | Keypair file (JSON byte array or base58), live mode only |
| `SEND_VIA` | `jito` | `jito` or `rpc` |
| `FALLBACK_TO_RPC` | `true` | Retry over RPC if Jito refuses the send |
| `JITO_TIP_LAMPORTS` | `10000` | Tip added to the transaction (Jito minimum is 1000) |
| `JITO_UUID` | none | Optional Jito UUID; without it the limit is about 1 request/sec per IP |
| `PRIORITY_FEE_LAMPORTS` | `10000` | Priority fee passed to Jupiter |
| `MIN_SOL_RESERVE` | `0.003` | Live swaps are refused if they would leave less SOL than this |

See `.env.example` for the full list and `strategy.example.json` for the JSON form.

## Going live

1. Run in dry-run first and read the logs until the behavior makes sense.
2. Use a fresh wallet that holds only money you can afford to lose.
3. Set `KEYPAIR_PATH`, then `DRY_RUN=false`. Start with a tiny `MAX_POSITION_SOL`.
4. A first buy needs more SOL than the swap amount. A token account costs about 0.00204 SOL in rent, and Jupiter briefly creates a wrapped-SOL account that also needs rent up front (refunded in the same transaction). Plus the network fee, priority fee and Jito tip. The bot checks this before sending and refuses when the balance is too low.

The live path has been tested live on mainnet. You are responsible for testing it with small amounts before trusting it.

## Safety

- `.env`, key files, `logs/` and `state/` are git-ignored. Never commit keys.
- Secrets are never logged. The startup log only says whether a keypair or UUID is set.
- The bot stops after `MAX_TRADES` trades or `MAX_CONSECUTIVE_ERRORS` errors in a row.

## Project layout

```
src/config.ts    env and strategy.json loading
src/jupiter.ts   quote and swap-instructions client
src/jito.ts      keypair loading, tip account, Jito sendTransaction
src/tx.ts        transaction building and confirmation polling
src/trade.ts     executeSwap: dry-run or live, with balance checks
src/market.ts    executable price sampling
src/strategy.ts  pure buy/sell decision function
src/state.ts     position file
src/bot.ts       polling loop
src/swap.ts      one-shot swap CLI
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
