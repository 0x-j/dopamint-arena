import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { engineClient } from "@/engine/engineClient";
import { deviceTierInfo, type DeviceTier } from "@/engine/deviceTier";

/** Human labels for the capability tiers (deviceTier derives these from cores + memory). */
const TIER_LABEL: Record<DeviceTier, string> = {
  low: "Basic",
  mid: "Standard",
  high: "High-end",
  max: "Max",
};

/**
 * Capacity hint for the game pickers: how many game windows this device is rated to run at once
 * (its {@link deviceTierInfo} cap) versus how many are live now, plus a lag warning as the count
 * approaches the cap. The cap is derived from CPU cores + memory; opening past it risks stutter
 * because every game's board still paints on the one main thread (and, on the shared hub, co-signs
 * on one worker thread). Poll-refreshed so it tracks windows opening/closing while the picker is up.
 */
export function DeviceCapNotice() {
  const info = deviceTierInfo(); // session-stable
  const [live, setLive] = useState(() => engineClient.liveWindowStats().live);
  useEffect(() => {
    const id = setInterval(
      () => setLive(engineClient.liveWindowStats().live),
      1000,
    );
    return () => clearInterval(id);
  }, []);

  const { cap, cores } = info;
  const overCap = live >= cap;
  const nearCap = live >= cap - 1; // opening one more reaches or exceeds the cap

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          Games running{" "}
          <span className="font-semibold text-foreground">{live}</span> / {cap}
        </span>
        <span className="text-muted-foreground">
          {TIER_LABEL[info.tier]}
          {cores ? ` · ${cores} cores` : ""}
        </span>
      </div>
      {nearCap && (
        <p
          className={cn(
            "flex items-start gap-1.5",
            overCap ? "text-destructive" : "text-amber-600 dark:text-amber-400",
          )}
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            {overCap
              ? `At this device's limit (${cap}). More games may stutter — close some to keep play smooth.`
              : `Near this device's limit (${cap}). Adding more may cause stutter.`}
          </span>
        </p>
      )}
    </div>
  );
}
