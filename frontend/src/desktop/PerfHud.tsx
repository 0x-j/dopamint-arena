/**
 * Performance HUD — a debug overlay to empirically TEST the worker-engine claim "the per-move crypto
 * loop no longer bottlenecks the main thread." It puts the load-bearing signals side by side:
 *
 *  - **Main FPS** + **worst frame (ms)** — sampled from a `requestAnimationFrame` loop. If the main
 *    thread were doing the co-sign hot loop, rAF callbacks would be starved → FPS drops, worst-frame
 *    spikes. Staying ~60fps while many games run is the proof the loop is off-main.
 *  - **Long tasks** (count + longest) — `PerformanceObserver('longtask')` flags any main-thread block
 *    >50ms. Few/none while workers churn = main stays responsive.
 *  - **Σ TPS** — aggregate co-signed updates/sec across every worker (the work that DID move off main).
 *  - **Workers** — live self-play isolates vs the device cap; turns red at the cap.
 *
 * Enable with `?perf=1` or toggle with Ctrl+Alt+P. Self-contained inline styles (it's a dev tool, not
 * product chrome) and rendered above everything. Its own cost is one rAF + a 250ms flush — measured
 * load stays in the workers, not here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useSampledRate } from "@/telemetry/useSampledRate";
import { engineClient } from "@/engine/engineClient";

function perfHudInitiallyOn(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("perf") === "1";
}

export function PerfHud() {
  const [show, setShow] = useState(perfHudInitiallyOn);

  // Ctrl+Alt+P toggles the HUD at runtime (no reload), so testers can flip it on mid-session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.code === "KeyP") {
        e.preventDefault();
        setShow((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!show) return null;
  return <PerfHudPanel onClose={() => setShow(false)} />;
}

function PerfHudPanel({ onClose }: { onClose: () => void }) {
  const { getGamesTotal } = useTelemetry();
  const tps = useSampledRate(
    useCallback(() => getGamesTotal(), [getGamesTotal]),
  );

  const [fps, setFps] = useState(0);
  const [worst, setWorst] = useState(0);
  const [longTasks, setLongTasks] = useState({ count: 0, maxMs: 0 });
  const [workers, setWorkers] = useState({ live: 0, max: 0, atCap: false });
  const longRef = useRef({ count: 0, maxMs: 0 });

  // Frame timing: record every rAF delta into a rolling ~2s ring (cheap, no render), then flush
  // derived FPS/worst to state at 4Hz so the HUD's own re-renders don't perturb what it measures.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const dts: number[] = [];
    const tick = (now: number) => {
      dts.push(now - last);
      last = now;
      if (dts.length > 120) dts.shift();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const flush = setInterval(() => {
      const recent = dts.slice(-60); // last ~1s of frames
      if (recent.length === 0) return;
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      setFps(Math.round(1000 / avg));
      setWorst(Math.round(Math.max(...recent)));
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(flush);
    };
  }, []);

  // Long tasks (>50ms main-thread blocks) accumulate since the panel opened; Reset zeroes them.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    let obs: PerformanceObserver;
    try {
      obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longRef.current.count += 1;
          longRef.current.maxMs = Math.max(longRef.current.maxMs, e.duration);
        }
        setLongTasks({
          count: longRef.current.count,
          maxMs: Math.round(longRef.current.maxMs),
        });
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch {
      return; // longtask entry type unsupported (e.g. Safari) — the other metrics still work
    }
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const poll = () => setWorkers(engineClient.liveWindowStats());
    poll();
    const id = setInterval(poll, 500);
    return () => clearInterval(id);
  }, []);

  const resetLong = () => {
    longRef.current = { count: 0, maxMs: 0 };
    setLongTasks({ count: 0, maxMs: 0 });
  };

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>⚡ perf</span>
        <button
          type="button"
          onClick={onClose}
          style={closeStyle}
          title="Hide (Ctrl+Alt+P)"
        >
          ×
        </button>
      </div>
      <Row label="Main FPS" value={fps || "—"} color={fpsColor(fps)} />
      <Row label="Worst frame" value={`${worst}ms`} color={frameColor(worst)} />
      <Row
        label="Long tasks"
        value={`${longTasks.count}${longTasks.maxMs ? ` · ${longTasks.maxMs}ms` : ""}`}
        color={
          longTasks.count === 0 ? GREEN : longTasks.maxMs > 100 ? RED : AMBER
        }
      />
      <Row
        label="Σ TPS"
        value={tps == null ? "—" : Math.round(tps).toLocaleString("en-US")}
        color="#8ad"
      />
      <Row
        label="Workers"
        value={`${workers.live}/${workers.max}`}
        color={workers.atCap ? RED : "#8ad"}
      />
      <button type="button" onClick={resetLong} style={resetStyle}>
        reset long tasks
      </button>
    </div>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div style={rowStyle}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

const GREEN = "#3ddc84";
const AMBER = "#ffb454";
const RED = "#ff5d5d";
const fpsColor = (fps: number) => (fps >= 55 ? GREEN : fps >= 30 ? AMBER : RED);
const frameColor = (ms: number) => (ms <= 20 ? GREEN : ms <= 50 ? AMBER : RED);

const panelStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 12,
  left: 12,
  zIndex: 99999,
  width: 168,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(12,14,20,0.88)",
  border: "1px solid rgba(255,255,255,0.12)",
  backdropFilter: "blur(4px)",
  color: "#e8ecf4",
  font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
  pointerEvents: "auto",
  userSelect: "none",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 4,
  fontWeight: 700,
  letterSpacing: 0.5,
  opacity: 0.85,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  tabSize: 4,
};
const closeStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#e8ecf4",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};
const resetStyle: React.CSSProperties = {
  marginTop: 6,
  width: "100%",
  padding: "2px 0",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.06)",
  color: "#cdd3df",
  cursor: "pointer",
  font: "inherit",
};
