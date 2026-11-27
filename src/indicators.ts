/** All indicators are causal: value[i] only uses candles 0..i (or 0..i-1 where stated). */

export function sma(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i]!;
    if (i >= n) sum -= x[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function rollingStd(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let mean = 0;
    for (let j = i - n + 1; j <= i; j++) mean += x[j]!;
    mean /= n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (x[j]! - mean) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(close: number[], n: number): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < close.length; i++) {
    const d = close[i]! - close[i - 1]!;
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/** Highest high of the PREVIOUS n candles (excludes candle i itself, so a breakout is detectable at i). */
export function prevHighest(high: number[], n: number): number[] {
  const out = new Array<number>(high.length).fill(NaN);
  for (let i = n; i < high.length; i++) {
    let m = -Infinity;
    for (let j = i - n; j < i; j++) m = Math.max(m, high[j]!);
    out[i] = m;
  }
  return out;
}

export function prevLowest(low: number[], n: number): number[] {
  const out = new Array<number>(low.length).fill(NaN);
  for (let i = n; i < low.length; i++) {
    let m = Infinity;
    for (let j = i - n; j < i; j++) m = Math.min(m, low[j]!);
    out[i] = m;
  }
  return out;
}
