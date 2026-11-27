# Backtest results (generated 2026-11-27)

Produced by `npm run backtest` (full report: `backtest/output/backtest-results.txt`, git-ignored).
Data: real Binance spot klines, SOL/USDT and JUP/USDT as proxies for the SOL/USDC and JUP/USDC pairs
the bot trades on Jupiter. These numbers describe one past year in one market regime. They are not a forecast.

## Setup

- Costs: 0.1% fee + 0.1% slippage per side (about 0.4% per round trip). 1x, all-in per position, no leverage.
- No lookahead: a signal is computed at candle *i*'s close and filled at candle *i+1*'s open. Indicators are causal.
- Datasets: SOL 1h (~1 year), JUP 1h (~1 year), SOL 15m (~3 months), JUP 15m (~3 months). The first 30 days of each are warmup.
- Out-of-sample: the first 70% of each window tunes a few params per strategy; the last 30% is a test only.
- Over the 1-year window SOL fell from 143 to 71.5 (buy and hold -50.2%). JUP went 0.258 -> 0.240.

## Summary across the 4 datasets

Avg rank = average position by Sharpe among 11 rows (1 = best). "Beats B&H" counts datasets out of 4.

```
Strategy                OOS avgRank  OOS avgSharpe  OOS avgRet%  OOS ret>0  OOS beats B&H Sharpe  OOS beats B&H Ret  Full avgRank  Full avgSharpe
----------------------  -----------  -------------  -----------  ---------  --------------------  -----------------  ------------  --------------
Grid                            3.5           0.02          2.2        2/4                   3/4                2/4           2.0           -0.22
RSI (long/short)                4.5          -0.16        -24.0        1/4                   2/4                2/4           3.8           -0.78
Bollinger (long)                4.5          -0.64          1.7        3/4                   3/4                3/4           8.3           -3.76
MA cross (long)                 6.0          -1.68        -11.2        1/4                   2/4                2/4           7.0           -2.41
RSI (long)                      6.0          -1.00        -10.6        1/4                   3/4                3/4           3.5           -0.90
Buy & hold                      6.3          -1.04         -2.7        1/4                     -                  -           3.0           -0.40
DCA weekly                      6.3          -1.24        -10.6        0/4                   2/4                2/4           3.3           -0.79
Donchian (long)                 6.3          -1.17         -7.5        0/4                   3/4                3/4           7.5           -3.30
Donchian (long/short)           7.0          -1.65        -18.3        1/4                   2/4                2/4           9.5           -4.27
Bollinger (long/short)          7.8          -1.57        -11.7        0/4                   0/4                2/4          10.5           -5.27
MA cross (long/short)           8.0          -1.16        -25.8        1/4                   1/4                1/4           7.8           -2.91
```

## Headline numbers (full window, default params)

| Dataset | Grid | Buy and hold | RSI long/short |
|---|---|---|---|
| SOL 1h (1y) | -10.5% (MaxDD 17.7%) | -50.2% (MaxDD 58.7%) | +9.5% (MaxDD 59.3%) |
| JUP 1h (1y) | +25.1% (MaxDD 18.8%) | -7.7% (MaxDD 48.3%) | -64.3% (MaxDD 83.5%) |
| SOL 15m (3mo) | -10.2% | -30.8% | -34.1% |
| JUP 15m (3mo) | +5.7% | +10.4% | -38.3% |

## What this says

- **Grid was the least bad**, not a winner: best out-of-sample average rank (3.5), out-of-sample average Sharpe about 0,
  and +2.2% average out-of-sample return. It lost money on SOL in a falling market, just much less than holding.
  Its edge here comes from a range-bound JUP year; in a strong one-way trend a long-only grid ends up holding all slots.
- **Costs kill the signal strategies.** With zero costs MA cross (long) on JUP 15m made +17.6%; at 0.2% per side it made -20.2%.
  Bollinger and Donchian traded 160-330 times a year and lost 40-60 points to costs alone.
- **RSI long/short** looked great in-sample on several datasets and then fell apart out-of-sample (e.g. JUP 1h: -85% OOS with tuned params).
  That is the textbook sign of overfitting.
- **Nothing reliably beat buy-and-hold on risk-adjusted terms** across all four datasets.

## Caveats

- Few independent samples: 2 highly correlated assets, one year, one regime. 1h and 15m runs overlap in time.
- One 70/30 split, not walk-forward. Close rankings are noise; slow strategies have few trades.
- Costs are an assumption. Real slippage on a thin token can be worse; next-open fills are idealized.
- Binance USDT prices are a proxy. Jupiter execution adds priority fees, Jito tips and token account rent,
  which matter a lot for the tiny sizes this bot defaults to.
- Short results ignore funding, borrow cost and liquidation. Real perps (with leverage) would be worse.
- Grid fills are optimistic: a level counts as filled whenever price trades through it.
- Sharpe uses the arithmetic mean of per-candle returns; read it together with return and max drawdown.
- Past performance does not predict future results. Not financial advice.
