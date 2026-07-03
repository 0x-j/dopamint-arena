import { Toaster } from "sonner";
import PvpBlackjack from "@/games/blackjack/app/pages/PvpBlackjack";
import { ScaledWrapper } from "./components/app/ScaledWrapper";
import "../blackjack.css";

export function SketchDefs() {
  return (
    <svg aria-hidden width="0" height="0" className="qp-defs">
      <filter id="qpRough" x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018"
          numOctaves={2}
          seed={7}
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale="2.6"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

export default function App({ windowId }: { windowId: string }) {
  return (
    <div className="bj-root qp-sketch w-full h-full relative overflow-hidden">
      <SketchDefs />
      <ScaledWrapper>
        <PvpBlackjack windowId={windowId} />
      </ScaledWrapper>
      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          style: {
            background: "#09090b",
            color: "#f4f4f5",
            border: "1px solid #27272a",
            borderRadius: "12px",
          },
        }}
      />
    </div>
  );
}
