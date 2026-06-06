import { useEffect, useState, type ReactNode } from "react";

const LICENSE_KEY = "16897463890072";
const STORAGE_KEY = "jb_license_ok";

export function LicenseGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setUnlocked(localStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (input.trim() === LICENSE_KEY) {
      localStorage.setItem(STORAGE_KEY, "1");
      setUnlocked(true);
      setError(null);
    } else {
      setError("Invalid license key");
    }
  }

  if (unlocked === null) return null;
  if (unlocked) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-card neon-border rounded-2xl p-6 space-y-5">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto rounded-lg neon-border flex items-center justify-center font-display font-bold text-primary text-xl">侍</div>
          <h1 className="font-display text-xl tracking-widest text-primary text-glow mt-3">JAPANESE BOT</h1>
          <p className="text-xs text-muted-foreground tracking-wider mt-1">ENTER LICENSE KEY</p>
        </div>
        <input
          autoFocus
          inputMode="numeric"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter your license key"
          className="w-full bg-input rounded-lg px-4 py-3 border border-border focus:outline-none focus:ring-2 focus:ring-ring font-display tracking-widest text-center"
        />
        {error && <div className="text-xs text-destructive text-center">{error}</div>}
        <button type="submit" className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-display font-bold tracking-[0.3em] neon-glow">
          UNLOCK
        </button>
        <p className="text-[10px] text-muted-foreground text-center tracking-wider">
          One-time activation. Stored locally on this device.
        </p>
      </form>
    </div>
  );
}
