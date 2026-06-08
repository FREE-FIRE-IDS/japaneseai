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
    throw new Error(json.message || `Market data error (HTTP ${res.status})`);
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
    throw new Error(typeof apiMessage === "string" ? apiMessage : `Fallback market data error (HTTP ${res.status})`);
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

async function fetchMarketData(pair: string, timeframe: string, twelveKey: string, alphaKey?: string) {
  try {
    return { candles: await fetchSeries(pair, timeframe, 260, twelveKey), source: "Twelve Data" };
  } catch (primaryError) {
    if (!alphaKey) throw primaryError;
    return { candles: await fetchAlphaSeries(pair, timeframe, 260, alphaKey), source: "Fallback feed" };
  }
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
    if (!["1min", "5min", "15min", "30min"].includes(d.timeframe)) throw new Error("Invalid timeframe");
    return d;
  })
  .handler(async ({ data }) => {
    const key = process.env.TWELVE_DATA_API_KEY;
    const alphaKey = process.env.ALPHA_VANTAGE_API_KEY || "HUO12PIJ5DFCNFPT";
    if (!key) throw new Error("API key not configured");

    // Pull execution candles, higher-timeframe trend, and the latest live quote together.
    // If the primary feed is limited/offline, silently switch to Alpha Vantage.
    const { ltf, htf, quote } = await fetchMarketData(data.pair, data.timeframe, key, alphaKey);

    const latestCandle = ltf[ltf.length - 1];
    const latestCandleTime = parseMarketTime(latestCandle?.datetime);
    const isLive = quote.time > 0
      ? Date.now() - quote.time <= Math.max(90_000, TF_SECONDS[data.timeframe] * 1500)
      : Date.now() - latestCandleTime <= Math.max(90_000, TF_SECONDS[data.timeframe] * 1500);

    const rawCloses = ltf.map((c) => parseFloat(c.close));
    const closes = [...rawCloses.slice(0, -1), quote.price];
    const htfCloses = htf.map((c) => parseFloat(c.close));

    const lastPrice = quote.price;
    const prevPrice = closes[closes.length - 2] ?? lastPrice;

    const r = rsi(closes, 14);
    const sma20 = sma(closes, Math.min(20, closes.length));
    const sma50 = sma(closes, Math.min(50, closes.length));
    const ema9Series = emaSeries(closes, 9);
    const ema21Series = emaSeries(closes, 21);
    const ema9 = ema9Series[ema9Series.length - 1];
    const ema21 = ema21Series[ema21Series.length - 1];
    const ema9Prev = ema9Series[ema9Series.length - 2] ?? ema9;
    const ema21Prev = ema21Series[ema21Series.length - 2] ?? ema21;

    const m = macd(closes);
    const momentum = ((lastPrice - prevPrice) / prevPrice) * 10000;
    const candleBodies = ltf.slice(-12).map((c) => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
    const typicalBody = median(candleBodies);
    const currentOpen = parseFloat(latestCandle.open);
    const liveBody = lastPrice - currentOpen;
    const liveBias = typicalBody > 0 ? Math.abs(liveBody) / typicalBody : 0;
    const spread = Number.isFinite(quote.bid) && Number.isFinite(quote.ask) ? Math.abs(quote.ask - quote.bid) : 0;
    const spreadOk = spread === 0 || spread <= Math.max(typicalBody * 0.45, lastPrice * 0.00008);

    // Higher timeframe trend
    const htfEma = emaSeries(htfCloses, 21);
    const htfTrendUp = htfCloses[htfCloses.length - 1] > htfEma[htfEma.length - 1];

    // Confluence scoring — each confirmed condition adds weight. Live candle and quote freshness are mandatory.
    let bull = 0, bear = 0;
    // RSI zones
    if (r < 30) bull += 2; else if (r < 45) bull += 1;
    if (r > 70) bear += 2; else if (r > 55) bear += 1;
    // Price vs SMAs
    if (lastPrice > sma20) bull += 1; else bear += 1;
    if (lastPrice > sma50) bull += 1; else bear += 1;
    // EMA stack + cross
    if (ema9 > ema21) bull += 1; else bear += 1;
    if (ema9Prev <= ema21Prev && ema9 > ema21) bull += 2; // fresh bullish cross
    if (ema9Prev >= ema21Prev && ema9 < ema21) bear += 2; // fresh bearish cross
    // MACD
    if (m.hist > 0) bull += 1; else bear += 1;
    if (m.macd > m.signal) bull += 1; else bear += 1;
    // Momentum
    if (momentum > 0) bull += 1; else if (momentum < 0) bear += 1;
    // Live candle pressure from the current quote, not only closed candles
    if (liveBody > 0 && liveBias >= 0.35) bull += 2;
    if (liveBody < 0 && liveBias >= 0.35) bear += 2;
    // HTF confluence (heavy weight — must align)
    if (htfTrendUp) bull += 2; else bear += 2;

    const total = bull + bear;
    const dominant = Math.max(bull, bear);
    const agreement = total === 0 ? 0 : dominant / total; // 0.5 - 1.0
    const fallbackDirection = momentum >= 0 ? "BUY" : "SELL";
    const wantedDirection: "BUY" | "SELL" = bull === bear ? fallbackDirection : bull > bear ? "BUY" : "SELL";
    const liveAligned = wantedDirection === "BUY" ? liveBody > 0 && momentum > 0 : liveBody < 0 && momentum < 0;
    const htfAligned = wantedDirection === "BUY" ? htfTrendUp : !htfTrendUp;
    let ai = { direction: wantedDirection as Direction, confidence: Math.max(55, Math.round(agreement * 100)), reason: "Live algorithmic scan" };
    if (isLive && spreadOk && liveBias >= 0.25) {
      try {
        ai = await askAiForSignal({
          pair: data.pair,
          timeframe: data.timeframe,
          price: lastPrice,
          closes,
          htfCloses,
          rsi: r,
          sma20,
          sma50,
          ema9,
          ema21,
          macdHist: m.hist,
          momentum,
          liveBody,
          liveBias,
          htfTrendUp,
          spreadOk,
          suggestedDirection: wantedDirection,
        });
      } catch {
        ai = { direction: wantedDirection, confidence: Math.max(55, Math.round(agreement * 100)), reason: "AI filter unavailable — using live algorithm" };
      }
    }

    const actionScore = Math.round(
      Math.min(
        98,
        Math.max(
          52,
          agreement * 72 + Math.min(liveBias, 1.4) * 10 + (liveAligned ? 8 : 0) + (htfAligned ? 8 : 0),
        ),
      ),
    );
    const direction: Direction = ai.direction === "BUY" || ai.direction === "SELL" ? ai.direction : wantedDirection;
    const signalReason = !isLive
      ? "MARKET CLOSED / STALE DATA"
      : !spreadOk
      ? "SPREAD TOO HIGH"
      : !htfAligned
      ? "HTF NOT ALIGNED"
      : !liveAligned
      ? "LIVE CANDLE NOT CONFIRMED"
      : liveBias < 0.35
      ? "WEAK LIVE PRESSURE"
      : agreement < 0.82
      ? "LOW CONFLUENCE"
      : ai.direction !== wantedDirection
      ? `AI SAYS ${ai.direction}`
      : ai.confidence < 70
      ? "AI CONFIDENCE LOW"
      : "LIVE CONFIRMED";

    const confidence = Math.min(98, Math.max(actionScore, ai.confidence || 0));

    const expirySeconds = TF_SECONDS[data.timeframe];

    return {
      pair: data.pair,
      timeframe: data.timeframe,
      direction,
      confidence,
      strength: Math.round(agreement * 100),
      price: lastPrice,
      rsi: Math.round(r * 10) / 10,
      sma20: Math.round(sma20 * 100000) / 100000,
      ema9: Math.round(ema9 * 100000) / 100000,
      momentum: Math.round(momentum * 10) / 10,
      expirySeconds,
      generatedAt: Date.now(),
      sparkline: closes.slice(-30),
      htfAligned,
      isLive,
      marketStatus: isLive ? "LIVE" : "MARKET CLOSED",
      waitReason: signalReason,
      aiDirection: ai.direction,
      aiConfidence: ai.confidence,
      aiReason: ai.reason,
      livePressure: Math.round(liveBias * 100),
      marketTime: quote.time || latestCandleTime,
    };
  });
