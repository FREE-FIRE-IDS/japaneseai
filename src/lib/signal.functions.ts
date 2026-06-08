import { createServerFn } from "@tanstack/react-start";

type Candle = { datetime: string; open: string; high: string; low: string; close: string };
type Direction = "BUY" | "SELL";

const PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD",
  "EUR/JPY", "GBP/JPY", "EUR/GBP", "AUD/JPY", "EUR/AUD", "GBP/CAD", "CHF/JPY",
];

const TF_SECONDS: Record<string, number> = { "1min": 60, "5min": 300, "15min": 900 };
const ALPHA_INTERVALS: Record<string, string> = {
  "1min": "1min",
  "5min": "5min",
  "15min": "15min",
};

function parseMarketTime(value?: string, timestamp?: number) {
  if (timestamp && Number.isFinite(timestamp)) return timestamp * 1000;
  if (!value) return 0;
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

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

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

async function fetchSeries(pair: string, interval: string, size: number, key: string) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${interval}&outputsize=${size}&timezone=UTC&apikey=${key}`;
  const res = await fetch(url);
  const json: { values?: Candle[]; status?: string; message?: string } = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "error" || !json.values) {
    throw new Error("Primary market feed unavailable");
  }
  return [...json.values].reverse();
}

function splitForexPair(pair: string) {
  const [from, to] = pair.split("/");
  if (!from || !to) throw new Error("Invalid forex pair");
  return { from, to };
}

async function fetchAlphaSeries(pair: string, interval: string, size: number, key: string) {
  const { from, to } = splitForexPair(pair);
  const alphaInterval = ALPHA_INTERVALS[interval] ?? "60min";
  const outputsize = size > 100 ? "full" : "compact";
  const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${encodeURIComponent(from)}&to_symbol=${encodeURIComponent(to)}&interval=${alphaInterval}&outputsize=${outputsize}&apikey=${key}`;
  const res = await fetch(url);
  const json: Record<string, unknown> = await res.json().catch(() => ({}));
  const apiMessage = json["Error Message"] || json.Information || json.Note;
  const seriesKey = `Time Series FX (${alphaInterval})`;
  const series = json[seriesKey] as Record<string, Record<string, string>> | undefined;
  if (!res.ok || apiMessage || !series) {
    throw new Error("Backup market feed unavailable");
  }

  return Object.entries(series)
    .map(([datetime, value]) => ({
      datetime,
      open: value["1. open"],
      high: value["2. high"],
      low: value["3. low"],
      close: value["4. close"],
    }))
    .filter((c) => Number.isFinite(parseFloat(c.close)))
    .sort((a, b) => parseMarketTime(a.datetime) - parseMarketTime(b.datetime))
    .slice(-size);
}

async function fetchMarketData(pair: string, timeframe: string, size: number, twelveKey?: string, alphaKey?: string) {
  if (twelveKey) {
    try {
      return { candles: await fetchSeries(pair, timeframe, size, twelveKey), source: "primary" };
    } catch { /* try backup feed */ }
  }
  if (alphaKey) {
    try {
      return { candles: await fetchAlphaSeries(pair, timeframe, size, alphaKey), source: "backup" };
    } catch { /* surface a clean app message below */ }
  }
  throw new Error("Real market feed unavailable right now. Try again shortly.");
}

function round(value: number, places = 5) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function describeCandle(open: number, close: number) {
  if (close > open) return "bullish";
  if (close < open) return "bearish";
  return "flat";
}

export const getPairs = createServerFn({ method: "GET" }).handler(async () => PAIRS);

export const generateSignal = createServerFn({ method: "POST" })
  .inputValidator((d: { pair: string; timeframe: string }) => {
    if (!PAIRS.includes(d.pair)) throw new Error("Invalid pair");
    if (!["1min", "5min", "15min"].includes(d.timeframe)) throw new Error("Invalid timeframe");
    return d;
  })
  .handler(async ({ data }) => {
    const key = process.env.TWELVE_DATA_API_KEY;
    const alphaKey = process.env.ALPHA_VANTAGE_API_KEY;

    const { candles } = await fetchMarketData(data.pair, data.timeframe, 260, key, alphaKey);
    const validCandles = candles.filter((c: Candle) =>
      [c.open, c.high, c.low, c.close].every((value) => Number.isFinite(parseFloat(value))),
    );
    if (validCandles.length < 205) throw new Error("Not enough real OHLC candles yet. Try another pair or timeframe.");

    const latestCandle = validCandles[validCandles.length - 1];
    const previousCandle = validCandles[validCandles.length - 2];
    const latestCandleTime = parseMarketTime(latestCandle.datetime);
    const marketAge = latestCandleTime > 0 ? Date.now() - latestCandleTime : 0;
    const isLive = latestCandleTime > 0 && marketAge <= Math.max(180_000, TF_SECONDS[data.timeframe] * 2200);

    const opens = validCandles.map((c: Candle) => parseFloat(c.open));
    const highs = validCandles.map((c: Candle) => parseFloat(c.high));
    const lows = validCandles.map((c: Candle) => parseFloat(c.low));
    const closes = validCandles.map((c: Candle) => parseFloat(c.close));
    const latestHigh = highs[highs.length - 1];
    const latestLow = lows[lows.length - 1];
    const lastOpen = opens[opens.length - 1];
    const lastPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2] ?? lastPrice;
    const threeBack = closes[closes.length - 4] ?? prevPrice;
    const candlesPerTenMinutes = Math.max(2, Math.ceil(600 / TF_SECONDS[data.timeframe]));
    const candlesBeforeLatest = validCandles.slice(0, -1);
    const tenMinuteWindow = candlesBeforeLatest
      .filter((c: Candle) => {
        const t = parseMarketTime(c.datetime);
        return latestCandleTime > 0 && t > 0 && latestCandleTime - t <= 600_000;
      })
      .slice(-candlesPerTenMinutes);
    const marketWindow = tenMinuteWindow.length >= 2 ? tenMinuteWindow : candlesBeforeLatest.slice(-candlesPerTenMinutes);
    const windowOpen = parseFloat(marketWindow[0]?.open ?? previousCandle.open);
    const windowClose = parseFloat(marketWindow[marketWindow.length - 1]?.close ?? previousCandle.close);
    const windowMid = marketWindow.reduce((sum, c) => sum + parseFloat(c.close), 0) / Math.max(1, marketWindow.length);

    const ema50Series = emaSeries(closes, 50);
    const ema200Series = emaSeries(closes, 200);
    const ema50 = ema50Series[ema50Series.length - 1];
    const ema200 = ema200Series[ema200Series.length - 1];
    const r = rsi(closes, 14);
    const candleType = describeCandle(lastOpen, lastPrice);
    const momentum = ((lastPrice - prevPrice) / prevPrice) * 10000;
    const momentum3 = ((lastPrice - threeBack) / threeBack) * 10000;
    const tenMinuteMove = ((windowClose - windowOpen) / windowOpen) * 10000;
    const latestRange = Math.max(latestHigh - latestLow, lastPrice * 0.00001);
    const latestBody = lastPrice - lastOpen;
    const bodyRatio = Math.abs(latestBody) / latestRange;
    const closePosition = (lastPrice - latestLow) / latestRange;
    const ema50Slope = ema50Series[ema50Series.length - 1] - ema50Series[ema50Series.length - 4];

    const upTrend = ema50 > ema200;
    const downTrend = ema50 < ema200;
    const bullishCandle = lastPrice > lastOpen;
    const bearishCandle = lastPrice < lastOpen;
    const upwardMomentum = momentum > 0 && momentum3 >= 0 && tenMinuteMove >= 0;
    const downwardMomentum = momentum < 0 && momentum3 <= 0 && tenMinuteMove <= 0;
    const latestBullConfirm = bullishCandle && closePosition >= 0.58 && bodyRatio >= 0.25;
    const latestBearConfirm = bearishCandle && closePosition <= 0.42 && bodyRatio >= 0.25;
    const buyRule = upTrend && r > 40 && r < 70 && latestBullConfirm && upwardMomentum && lastPrice >= windowMid;
    const sellRule = downTrend && r > 30 && r < 60 && latestBearConfirm && downwardMomentum && lastPrice <= windowMid;

    let buyScore = 0;
    let sellScore = 0;
    if (upTrend) buyScore += 24;
    if (downTrend) sellScore += 24;
    if (ema50Slope > 0) buyScore += 8;
    if (ema50Slope < 0) sellScore += 8;
    if (lastPrice > ema50) buyScore += 8;
    if (lastPrice < ema50) sellScore += 8;
    if (r > 40 && r < 70) buyScore += 16;
    if (r > 30 && r < 60) sellScore += 16;
    if (tenMinuteMove > 0) buyScore += 18;
    if (tenMinuteMove < 0) sellScore += 18;
    if (lastPrice >= windowMid) buyScore += 8;
    if (lastPrice <= windowMid) sellScore += 8;
    if (latestBullConfirm) buyScore += 24;
    if (latestBearConfirm) sellScore += 24;
    if (upwardMomentum) buyScore += 14;
    if (downwardMomentum) sellScore += 14;

    const direction: Direction = buyRule ? "BUY" : sellRule ? "SELL" : buyScore >= sellScore ? "BUY" : "SELL";
    const selectedScore = direction === "BUY" ? buyScore : sellScore;
    const oppositeScore = direction === "BUY" ? sellScore : buyScore;
    const trendGap = Math.abs((ema50 - ema200) / lastPrice) * 10000;
    const momentumPower = Math.min(10, Math.abs(momentum3));
    const strictSetup = direction === "BUY" ? buyRule : sellRule;
    const confidence = clamp(Math.round((strictSetup ? 72 : 58) + (selectedScore - oppositeScore) * 0.45 + Math.min(8, trendGap) + momentumPower), strictSetup ? 82 : 58, 96);
    const htfAligned = direction === "BUY" ? upTrend : downTrend;
    const livePressure = clamp(Math.round((Math.abs(lastPrice - lastOpen) / Math.max(Math.abs(prevPrice - lastOpen), lastPrice * 0.00004)) * 100), 0, 250);
    const signalReason = `${direction} by last 10-min ${tenMinuteMove >= 0 ? "bullish" : "bearish"} flow, latest ${candleType} candle, EMA50 ${direction === "BUY" ? ">" : "<"} EMA200, RSI ${round(r, 1)}`;

    const expirySeconds = TF_SECONDS[data.timeframe];

    return {
      pair: data.pair,
      timeframe: data.timeframe,
      direction,
      confidence,
      strength: selectedScore,
      price: lastPrice,
      rsi: round(r, 1),
      sma20: round(ema200),
      ema9: round(ema50),
      momentum: Math.round(momentum * 10) / 10,
      expirySeconds,
      generatedAt: Date.now(),
      sparkline: closes.slice(-30),
      htfAligned,
      isLive,
      marketStatus: isLive ? "LIVE" : "LAST CANDLE",
      waitReason: signalReason,
      aiDirection: direction,
      aiConfidence: confidence,
      aiReason: `Real OHLC only • previous 10-min flow + latest candle + EMA50/EMA200 + RSI14`,
      livePressure,
      marketTime: latestCandleTime,
    };
  });
