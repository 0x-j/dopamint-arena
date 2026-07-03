import { RouterProvider } from "@tanstack/react-router";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PerfHud } from "./desktop/PerfHud";
import { DemoWalletProvider } from "./wallet/useWalletSession";
import { ThemeProvider } from "./theme/useTheme";
import { TelemetryProvider } from "./telemetry/TelemetryProvider";
import { router } from "./router";

export function App() {
  // App-wide chrome lives here so theme, wallet, telemetry, tooltips, and toasts
  // work on every route. TelemetryProvider supplies the writer the real on-chain
  // games push their activity into; routing is defined in router.tsx.
  return (
    <ThemeProvider>
      <DemoWalletProvider>
        <TelemetryProvider>
          <TooltipProvider delayDuration={150}>
            <RouterProvider router={router} />
            <Toaster />
            <PerfHud />
          </TooltipProvider>
        </TelemetryProvider>
      </DemoWalletProvider>
    </ThemeProvider>
  );
}
