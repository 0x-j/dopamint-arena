import { useEffect, useRef } from "react";

import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import { useLocalGamesTps } from "@/telemetry/useLocalGamesTps";
import { fmtTps } from "@/lib/formatTps";
import { LiveBadge, OfflineBadge } from "./atoms";
import type { TelemetrySnapshot } from "./types";

const BARS = 36; // one bar per second → ~36s of history across the chart

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
// Log scale: ~1 tps → near 0, ~1e6 tps → near 1. Works across the whole live range
// (in-browser single digits today → fleet millions at the peak), unlike a fixed linear band.
const normalize = (tps: number) => clamp01(Math.log10(Math.max(1, tps)) / 6);

/** Reads the bar color off the canvas's cascade so the chart re-themes. */
function barColor(el: HTMLElement) {
  return getComputedStyle(el).getPropertyValue("--primary").trim() || "#613dff";
}

/** One labelled mono metric; a skeleton until live data arrives (never fabricated numbers). */
function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {value === null ? (
        <Skeleton className="mt-0.5 h-4 w-14" />
      ) : (
        <div className="wal-mono truncate text-xs font-semibold tabular-nums text-foreground">
          {value}
        </div>
      )}
    </div>
  );
}

/**
 * The dock's single at-a-glance network panel — the old "System Dashboard" + "Transactions / sec"
 * merged side-by-side so a LOW dock fits it whole with no scrolling: the live TPS hero + your-TPS
 * line + scrolling bar histogram on the left, the backend aggregates stacked on the right (the
 * "Network TPS" stat is dropped — it IS the hero). All numbers are real: backend SSE aggregates
 * (skeletons until live), the local rate summed from the open game windows.
 *
 * The histogram commits one bar per second, the live (rightmost) bar easing toward the current
 * rate; one rAF capped at ~30fps, paused while offscreen or the tab is hidden. It flexes with the
 * panel height (`flex-1` over an `h-16` basis), so a taller dock just grows the chart.
 */
export function NetworkPulse({
  snapshot,
  className,
}: {
  snapshot: TelemetrySnapshot;
  className?: string;
}) {
  const { backend, status } = useTelemetry();
  const isLive = status === "live" && backend !== null;
  const tps = Math.round(snapshot.rate.updatesPerSec);
  // The local user's TPS: the sum of every open game window's rate — each the same value its
  // header chip shows. Null when nothing is producing, so the line hides rather than showing 0.
  const localTps = useLocalGamesTps();
  // Latest normalized value for the animation loop. The effect re-runs when `isLive` flips so
  // the canvas (only mounted while live) gets its rAF wired up the moment it appears.
  const valueRef = useRef(0);
  valueRef.current = normalize(tps);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Only animate while live — when offline the canvas isn't mounted (skeleton shown instead).
    if (!isLive) return;
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;
    const ro = new ResizeObserver(() => {
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
    });
    ro.observe(cv);

    let visible = true;
    const io = new IntersectionObserver((e) => {
      visible = e[0]?.isIntersecting ?? true;
    });
    io.observe(cv);

    let color = barColor(cv);
    const themeWatch = new MutationObserver(() => {
      color = barColor(cv);
    });
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // Start empty (all 0) so the chart visibly builds up from zero; BARS-1
    // committed seconds + 1 live bar easing toward the current value.
    const committed = new Array<number>(BARS - 1).fill(0);
    let live = 0;
    let last = performance.now();
    let acc = 0;
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = (now - last) / 1000;
      last = now;
      if (!visible || document.hidden || !w || !h) return;

      // Ease the live (rightmost) bar toward the current rate every frame…
      live += (valueRef.current - live) * Math.min(1, dt * 6);
      // …and commit it as a new bar once per second (scrolling left).
      acc += dt;
      if (acc >= 1) {
        acc -= 1;
        committed.push(live);
        committed.shift();
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const gap = 2;
      const bw = (w - (BARS - 1) * gap) / BARS;
      const bars = [...committed, live];
      for (let i = 0; i < BARS; i++) {
        const bh = Math.max(0, bars[i] * (h - 2));
        // Newest bar full strength; history fades toward the left.
        ctx.globalAlpha = i === BARS - 1 ? 1 : 0.3 + (i / (BARS - 1)) * 0.45;
        ctx.fillStyle = color;
        ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      themeWatch.disconnect();
    };
  }, [isLive]);

  const fmt = (n: number | undefined) =>
    isLive && n !== undefined ? Math.round(n).toLocaleString("en-US") : null;
  const stats = [
    { label: "Total Actions", value: fmt(backend?.totalActions) },
    { label: "Active Tunnels", value: fmt(backend?.activeTunnels) },
    { label: "Settled Tunnels", value: fmt(backend?.settledTunnels) },
  ];

  return (
    <Panel className={className}>
      <PanelHeader className="py-1.5">
        <PanelTitle>Network Pulse</PanelTitle>
        <PanelAction>{isLive ? <LiveBadge /> : <OfflineBadge />}</PanelAction>
      </PanelHeader>
      <PanelContent className="flex gap-3 overflow-hidden p-2">
        <div className="flex min-w-0 flex-1 flex-col">
          {isLive ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="wal-doto text-3xl text-primary">
                  {tps.toLocaleString("en-US")}
                </span>
                <span className="wal-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  tx/sec · live
                </span>
              </div>
              {localTps != null && (
                <span className="wal-mono text-[10px] text-muted-foreground">
                  your TPS · {fmtTps(localTps)} tx/s
                </span>
              )}
              <div className="mt-1 h-16 w-full flex-1">
                <canvas ref={canvasRef} className="block h-full w-full" />
              </div>
            </>
          ) : localTps != null ? (
            // No backend, but open windows are producing real updates: show the measured local
            // total instead of a skeleton (never a placeholder — localTps is null when idle).
            <>
              <div className="flex items-baseline gap-2">
                <span className="wal-doto text-3xl text-primary">
                  {Math.round(localTps).toLocaleString("en-US")}
                </span>
                <span className="wal-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  tx/sec · your TPS
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Your play. Connect the stats backend for the network rate.
              </p>
            </>
          ) : (
            <>
              <Skeleton className="h-8 w-28" />
              <Skeleton className="mt-1 h-16 w-full flex-1" />
            </>
          )}
        </div>
        <div className="flex w-32 shrink-0 flex-col justify-center gap-1.5">
          {stats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} />
          ))}
        </div>
      </PanelContent>
    </Panel>
  );
}
