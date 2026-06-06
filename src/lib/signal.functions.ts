import { createServerFn } from "@tanstack/react-start";

type Candle = { datetime: string; open: string; high: string; low: string; close: string };

const PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD",
  "EUR/JPY", "GBP/JPY", "EUR/GBP", "AUD/JPY", "EUR/AUD", "GBP/CAD", "CHF/JPY",
];

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff >= 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export const getPairs = createServerFn({ method: "GET" }).handler(async () => PAIRS);

export const generateSignal = createServerFn({ method: "POST" })
  .inputValidator((d: { pair: string; timeframe: string }) => {
    if (!PAIRS.includes(d.pair)) throw new Error("Invalid pair");
    if (!["1min", "5min", "15min", "30min"].includes(d.timeframe)) throw new Error("Invalid timeframe");
    return d;
  })
  .handler(async ({ data }) => {
    const key = process.env.TWELVE_DATA_API_KEY;
    if (!key) throw new Error("API key not configured");

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(data.pair)}&interval=${data.timeframe}&outputsize=60&apikey=${key}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Market data fetch failed");
    const json: { values?: Candle[]; status?: string; message?: string; code?: number } = await res.json();
    if (json.status === "error" || !json.values) {
      throw new Error(json.message || "Market data unavailable");
    }

    // Twelve Data returns newest first — reverse for chronological order
    const candles = [...json.values].reverse();
    const closes = candles.map((c) => parseFloat(c.close));
    const lastPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2] ?? lastPrice;

    const r = rsi(closes, 14);
    const sma20 = sma(closes, Math.min(20, closes.length));
    const ema9 = ema(closes.slice(-15), 9);
    const momentum = ((lastPrice - prevPrice) / prevPrice) * 10000; // pips-ish

    // Score: combine RSI, trend (price vs SMA), EMA cross, momentum
    let score = 0;
    if (r < 30) score += 2; else if (r > 70) score -= 2;
    else if (r < 45) score += 1; else if (r > 55) score -= 1;
    if (lastPrice > sma20) score += 1; else score -= 1;
    if (ema9 > sma20) score += 1; else score -= 1;
    if (momentum > 0) score += 1; else if (momentum < 0) score -= 1;

    const direction: "BUY" | "SELL" = score >= 0 ? "BUY" : "SELL";
    const strength = Math.min(100, Math.round((Math.abs(score) / 5) * 100));
    const confidence = 55 + Math.round(strength * 0.4); // 55–95%

    const tfSeconds: Record<string, number> = { "1min": 60, "5min": 300, "15min": 900, "30min": 1800 };
    const expirySeconds = tfSeconds[data.timeframe];

    return {
      pair: data.pair,
      timeframe: data.timeframe,
      direction,
      confidence,
      strength,
      price: lastPrice,
      rsi: Math.round(r * 10) / 10,
      sma20: Math.round(sma20 * 100000) / 100000,
      ema9: Math.round(ema9 * 100000) / 100000,
      momentum: Math.round(momentum * 10) / 10,
      expirySeconds,
      generatedAt: Date.now(),
      sparkline: closes.slice(-30),
    };
  });
