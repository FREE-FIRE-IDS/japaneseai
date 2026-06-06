import { createServerFn } from "@tanstack/react-start";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";

type Candle = { datetime: string; open: string; high: string; low: string; close: string };
type Quote = { close?: string; bid?: string; ask?: string; datetime?: string; timestamp?: number; status?: string; message?: string };
type Direction = "BUY" | "SELL" | "WAIT";

const PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "USD/CHF", "NZD/USD",
  "EUR/JPY", "GBP/JPY", "EUR/GBP", "AUD/JPY", "EUR/AUD", "GBP/CAD", "CHF/JPY",
];

// Higher timeframe used for trend confirmation
const HTF: Record<string, string> = {
  "1min": "5min",
  "5min": "15min",
  "15min": "1h",
  "30min": "2h",
};

const TF_SECONDS: Record<string, number> = { "1min": 60, "5min": 300, "15min": 900, "30min": 1800 };

function parseMarketTime(value?: string, timestamp?: number) {
  if (timestamp && Number.isFinite(timestamp)) return timestamp * 1000;
  if (!value) return 0;
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
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

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function macd(values: number[]) {
  const e12 = emaSeries(values, 12);
  const e26 = emaSeries(values, 26);
  const macdLine = values.map((_, i) => e12[i] - e26[i]);
  const signalLine = emaSeries(macdLine.slice(-Math.min(values.length, 35)), 9);
  const m = macdLine[macdLine.length - 1];
  const s = signalLine[signalLine.length - 1];
  return { macd: m, signal: s, hist: m - s };
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

async function fetchQuote(pair: string, key: string) {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(pair)}&apikey=${key}`;
  const res = await fetch(url);
  const json: Quote = await res.json().catch(() => ({}));
  if (!res.ok || json.status === "error") throw new Error(json.message || `Live quote error (HTTP ${res.status})`);

  const bid = json.bid ? parseFloat(json.bid) : NaN;
  const ask = json.ask ? parseFloat(json.ask) : NaN;
  const close = json.close ? parseFloat(json.close) : NaN;
  const price = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : close;
  if (!Number.isFinite(price)) throw new Error("Live quote unavailable");

  return { price, bid, ask, time: parseMarketTime(json.datetime, json.timestamp) };
}

const AiSignalSchema = z.object({
  direction: z.enum(["BUY", "SELL", "WAIT"]),
  confidence: z.number(),
  reason: z.string(),
});

async function askAiForSignal(input: {
  pair: string;
  timeframe: string;
  price: number;
  closes: number[];
  htfCloses: number[];
  rsi: number;
  sma20: number;
  sma50: number;
  ema9: number;
  ema21: number;
  macdHist: number;
  momentum: number;
  liveBody: number;
  liveBias: number;
  htfTrendUp: boolean;
  spreadOk: boolean;
}) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return { direction: "WAIT" as Direction, confidence: 0, reason: "AI unavailable" };

  const gateway = createLovableAiGatewayProvider(key);
  const { output } = await generateText({
    model: gateway("google/gemini-3-flash-preview"),
    output: Output.object({ schema: AiSignalSchema }),
    system: "You are a strict live forex signal risk filter. Never invent market data. Use only the supplied candles, quote, and indicators. Return WAIT unless live momentum, trend, and candle pressure are clearly aligned. No guaranteed-profit claims.",
    prompt: JSON.stringify({
      pair: input.pair,
      timeframe: input.timeframe,
      liveQuote: input.price,
      lastCloses: input.closes.slice(-24),
      higherTimeframeCloses: input.htfCloses.slice(-18),
      indicators: {
        rsi: input.rsi,
        sma20: input.sma20,
        sma50: input.sma50,
        ema9: input.ema9,
        ema21: input.ema21,
        macdHist: input.macdHist,
        momentum: input.momentum,
        liveBody: input.liveBody,
        livePressureRatio: input.liveBias,
        htfTrendUp: input.htfTrendUp,
        spreadOk: input.spreadOk,
      },
      rule: "direction must be BUY, SELL, or WAIT. Use WAIT if uncertain, mixed, stale-looking, or weak pressure. confidence 0-98.",
    }),
  });

  return {
    direction: output.direction as Direction,
    confidence: Math.max(0, Math.min(98, Math.round(output.confidence))),
    reason: output.reason.slice(0, 140),
  };
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

    // Pull execution candles, higher-timeframe trend, and the latest live quote together.
    const [ltf, htf, quote] = await Promise.all([
      fetchSeries(data.pair, data.timeframe, 100, key),
      fetchSeries(data.pair, HTF[data.timeframe], 60, key),
      fetchQuote(data.pair, key),
    ]);

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
    const wantedDirection = bull > bear ? "BUY" : "SELL";
    const liveAligned = wantedDirection === "BUY" ? liveBody > 0 && momentum > 0 : liveBody < 0 && momentum < 0;
    const htfAligned = wantedDirection === "BUY" ? htfTrendUp : !htfTrendUp;
    let ai = { direction: "WAIT" as Direction, confidence: 0, reason: "AI not checked" };
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
        });
      } catch {
        ai = { direction: "WAIT", confidence: 0, reason: "AI filter unavailable" };
      }
    }

    const direction: Direction =
      isLive && spreadOk && htfAligned && liveAligned && liveBias >= 0.35 && agreement >= 0.82
        && ai.direction === wantedDirection && ai.confidence >= 70
        ? wantedDirection
        : "WAIT";
    const waitReason = !isLive
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
      : "NO TRADE";

    // Confidence scaled from agreement (82% → 80 conf, 100% → 98 conf)
    const confidence = direction === "WAIT"
      ? Math.round(Math.min(79, agreement * 100))
      : Math.min(98, Math.round((Math.min(98, 80 + (agreement - 0.82) * 100) + ai.confidence) / 2));

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
      htfAligned: direction === "WAIT" ? false : htfAligned,
      isLive,
      marketStatus: isLive ? "LIVE" : "MARKET CLOSED",
      waitReason: direction === "WAIT" ? waitReason : "LIVE CONFIRMED",
      aiDirection: ai.direction,
      aiConfidence: ai.confidence,
      aiReason: ai.reason,
      livePressure: Math.round(liveBias * 100),
      marketTime: quote.time || latestCandleTime,
    };
  });
