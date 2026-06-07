import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateSignal, getPairs } from "@/lib/signal.functions";
import { Sparkline } from "@/components/Sparkline";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "JAPANESE BOT — Forex Signals" },
      { name: "description", content: "Real-time forex UP/DOWN signals powered by live market data." },
      { property: "og:title", content: "JAPANESE BOT" },
      { property: "og:description", content: "Real-time forex UP/DOWN signals." },
      { name: "theme-color", content: "#00ff88" },
    ],
  }),
  loader: async () => ({ pairs: await getPairs() }),
  component: Index,
});

type Signal = Awaited<ReturnType<typeof generateSignal>>;

const TIMEFRAMES = [
  { value: "1min", label: "1M" },
  { value: "5min", label: "5M" },
  { value: "15min", label: "15M" },
  { value: "30min", label: "30M" },
];

function displayDirection(direction: "BUY" | "SELL") {
  return direction === "BUY" ? "UP" : "DOWN";
}

function Index() {
  const { pairs } = Route.useLoaderData();
  const gen = useServerFn(generateSignal);
  const [pair, setPair] = useState(pairs[0]);
  const [timeframe, setTimeframe] = useState("1min");
  const [loading, setLoading] = useState(false);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [history, setHistory] = useState<Signal[]>([]);
  const [autoScan, setAutoScan] = useState(false);
  const [banner, setBanner] = useState<{ title: string; body: string; tone: "signal" | "wait" } | null>(null);
  const scanningRef = useRef(false);

  useEffect(() => {
    setAutoScan(localStorage.getItem("jb_auto_scan") === "1");
  }, []);

  useEffect(() => {
    localStorage.setItem("jb_auto_scan", autoScan ? "1" : "0");
  }, [autoScan]);

  useEffect(() => {
    if (!signal) return;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - signal.generatedAt) / 1000);
      setRemaining(Math.max(0, signal.expirySeconds - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [signal]);

  const onGenerate = useCallback(async (silent = false) => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    if (!silent) setLoading(true);
    setError(null);
    try {
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch { /* ignore */ }
      }
      const s = await gen({ data: { pair, timeframe } });
      s.generatedAt = Date.now();
      setSignal(s);
      setHistory((h) => [s, ...h].slice(0, 8));

      const directionLabel = displayDirection(s.direction);
      const title = `${directionLabel} ${s.pair}`;
      const body = `Signal ${s.confidence}% • ${s.timeframe} • ${s.waitReason}`;
      setBanner({ title, body, tone: "signal" });
      window.setTimeout(() => setBanner(null), 6500);

      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate?.([160, 70, 160, 70, 220]);
      }
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        const notification = new Notification(`${directionLabel} ${s.pair}`, {
          body: `Signal ${s.confidence}% • ${s.timeframe}`,
          icon: "/favicon.png",
          tag: "jb-signal",
        });
        notification.onclick = () => window.focus();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to generate signal";
      setError(message);
      if (!silent) setBanner({ title: "SCAN FAILED", body: message, tone: "wait" });
    } finally {
      scanningRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [gen, pair, timeframe]);

  useEffect(() => {
    if (!autoScan) return;
    onGenerate(true);
    const id = window.setInterval(() => onGenerate(true), 20_000);
    return () => window.clearInterval(id);
  }, [autoScan, onGenerate]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;

    // Detect Lovable preview iframe — skip SW there
    const inIframe = window.self !== window.top;
    const host = window.location.hostname;
    const isPreview = inIframe || host.startsWith("id-preview--") || host.startsWith("preview--") || host.endsWith(".lovableproject.com");

    let swReg: ServiceWorkerRegistration | null = null;

    const showPersistent = (title: string, body: string) => {
      if (swReg) {
        swReg.active?.postMessage({ type: "SHOW_NOTIFICATION", title, body, tag: "jb-scan-cta" });
      } else {
        const n = new Notification(title, { body, icon: "/favicon.png", tag: "jb-scan-cta" });
        n.onclick = () => { window.focus(); onGenerate(false); };
      }
    };

    const init = async () => {
      if (!isPreview && "serviceWorker" in navigator) {
        try {
          swReg = await navigator.serviceWorker.register("/sw-notify.js");
          await navigator.serviceWorker.ready;
        } catch { /* ignore */ }
      }
      const fire = () => showPersistent("JAPANESE BOT READY", "Open Quotex, pick OTC pair, then tap SCAN NOW");
      if (Notification.permission === "granted") fire();
      else if (Notification.permission === "default") {
        const p = await Notification.requestPermission().catch(() => "denied" as NotificationPermission);
        if (p === "granted") fire();
      }
    };
    init();

    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "TRIGGER_SCAN") onGenerate(false);
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);

    // ?scan=1 deep link from notification click
    if (new URLSearchParams(window.location.search).get("scan") === "1") {
      onGenerate(false);
    }

    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, [onGenerate]);


  const mmss = useMemo(() => {
    const m = Math.floor(remaining / 60).toString().padStart(2, "0");
    const s = (remaining % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }, [remaining]);

  return (
    <div className="min-h-screen px-4 py-8 md:py-12 max-w-3xl mx-auto">
      {banner && (
        <div className={`fixed left-4 right-4 top-4 z-50 mx-auto max-w-md rounded-xl border px-4 py-3 shadow-2xl backdrop-blur-md ${banner.tone === "signal" ? "neon-border bg-card/95" : "border-border bg-card/90"}`}>
          <div className="flex items-center gap-3">
            <span className={`h-3 w-3 rounded-full ${banner.tone === "signal" ? "bg-primary animate-pulse-neon" : "bg-muted-foreground"}`} />
            <div className="min-w-0">
              <div className="font-display text-sm font-bold tracking-widest text-primary">{banner.title}</div>
              <div className="truncate text-xs text-muted-foreground">{banner.body}</div>
            </div>
          </div>
        </div>
      )}

      <header className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg neon-border flex items-center justify-center font-display font-bold text-primary">侍</div>
          <div>
            <h1 className="font-display text-xl md:text-2xl font-bold tracking-widest text-primary text-glow">JAPANESE BOT</h1>
            <p className="text-xs text-muted-foreground tracking-wider">FOREX SIGNAL ENGINE</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse-neon" />
          <span className="text-muted-foreground">LIVE</span>
        </div>
      </header>

      {/* Controls */}
      <div className="bg-card rounded-2xl p-5 md:p-6 neon-border space-y-5">
        <div>
          <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Currency Pair</label>
          <select
            value={pair}
            onChange={(e) => setPair(e.target.value)}
            className="w-full bg-input text-foreground rounded-lg px-4 py-3 border border-border focus:outline-none focus:ring-2 focus:ring-ring font-display tracking-wider"
          >
            {pairs.map((p: string) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div>
          <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Expiry / Timeframe</label>
          <div className="grid grid-cols-4 gap-2">
            {TIMEFRAMES.map((t) => (
              <button
                key={t.value}
                onClick={() => setTimeframe(t.value)}
                className={`py-3 rounded-lg font-display tracking-widest text-sm transition-all ${
                  timeframe === t.value
                    ? "bg-primary text-primary-foreground neon-glow"
                    : "bg-secondary text-secondary-foreground hover:bg-accent"
                }`}
              >{t.label}</button>
            ))}
          </div>
        </div>

        <button
          onClick={() => onGenerate(false)}
          disabled={loading}
          className="w-full py-4 rounded-xl bg-primary text-primary-foreground font-display font-bold tracking-[0.3em] text-lg neon-glow disabled:opacity-50 transition-transform active:scale-[0.98]"
        >
          {loading ? "ANALYZING…" : "GENERATE SIGNAL"}
        </button>

        <button
          onClick={() => setAutoScan((v) => !v)}
          className={`w-full py-3 rounded-xl border font-display font-bold tracking-[0.22em] text-sm transition-all ${autoScan ? "bg-primary text-primary-foreground neon-glow border-primary" : "bg-secondary text-secondary-foreground border-border hover:bg-accent"}`}
        >
          {autoScan ? "AUTO SCAN ON" : "AUTO SCAN OFF"}
        </button>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-lg p-3">{error}</div>
        )}
      </div>

      {/* Signal */}
      {signal && (
        <div className="mt-6 bg-card rounded-2xl p-6 neon-border relative overflow-hidden">
          <div className="absolute inset-x-0 h-px bg-primary/40 animate-scan" />

          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-xs text-muted-foreground tracking-widest">SIGNAL</div>
              <div className="font-display text-2xl tracking-wider">{signal.pair}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground tracking-widest">EXPIRES IN</div>
              <div className="font-display text-2xl text-primary text-glow tabular-nums">{mmss}</div>
            </div>
          </div>

          <div
            className="rounded-xl py-6 text-center mb-5 neon-glow"
            style={{
              background: signal.direction === "BUY"
                ? "linear-gradient(135deg, var(--buy), color-mix(in oklab, var(--buy) 60%, black))"
                : "linear-gradient(135deg, var(--sell), color-mix(in oklab, var(--sell) 60%, black))",
              color: "#0a0a0a",
            }}
          >
            <div className="text-xs tracking-[0.4em] opacity-70">DIRECTION</div>
            <div className="font-display text-5xl md:text-6xl font-black tracking-widest">{displayDirection(signal.direction)}</div>
            <div className="text-sm mt-2 tracking-wider opacity-80">
              Confidence {signal.confidence}% • {signal.marketStatus} • HTF {signal.htfAligned ? "✓ aligned" : "× mixed"}
            </div>
          </div>

          <Sparkline data={signal.sparkline} direction={signal.direction} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5 text-sm">
            <Stat label="PRICE" value={signal.price.toFixed(5)} />
            <Stat label="MARKET" value={signal.marketStatus} />
            <Stat label="PRESSURE" value={`${signal.livePressure}%`} />
            <Stat label="AI" value={`${signal.aiDirection} ${signal.aiConfidence}%`} />
            <Stat label="RSI" value={signal.rsi.toString()} />
            <Stat label="SMA 20" value={signal.sma20.toFixed(5)} />
            <Stat label="EMA 9" value={signal.ema9.toFixed(5)} />
          </div>
          <div className="mt-3 rounded-lg bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            AI CHECK: {signal.aiReason}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 1 && (
        <div className="mt-6">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-3">Recent Signals</h2>
          <div className="space-y-2">
            {history.slice(1).map((s, i) => (
              <div key={i} className="bg-card/60 border border-border rounded-lg px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`font-display font-bold text-sm px-2 py-1 rounded ${s.direction === "BUY" ? "text-buy" : "text-sell"}`} style={{ background: s.direction === "BUY" ? "color-mix(in oklab, var(--buy) 15%, transparent)" : "color-mix(in oklab, var(--sell) 15%, transparent)" }}>
                    {displayDirection(s.direction)}
                  </span>
                  <span className="font-display tracking-wider text-sm">{s.pair}</span>
                  <span className="text-xs text-muted-foreground">{s.timeframe}</span>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">{s.confidence}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <footer className="text-center text-xs text-muted-foreground mt-10 tracking-wider">
        ⚠ Signals are algorithmic estimates. Trade at your own risk.
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/50 rounded-lg px-3 py-2">
      <div className="text-[10px] text-muted-foreground tracking-widest">{label}</div>
      <div className="font-display tabular-nums text-sm">{value}</div>
    </div>
  );
}
