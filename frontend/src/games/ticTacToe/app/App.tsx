import { useEffect, useRef, useState } from "react";
import { CustomWalletProvider } from "@/games/ticTacToe/app/contexts/CustomWallet";
import { PvpScene } from "@/games/ticTacToe/app/scenes/PvpScene";
import { SketchDefs } from "@/games/blackjack/app/App";
import "./index.css";

function AppContent({
  windowId,
  onClose,
}: {
  windowId: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 1024, height: 768 });

  // Track the actual container element's parent bounds to determine orientation.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const parent = el.parentElement;
    if (!parent) return;

    const handleResize = () => {
      const w = parent.clientWidth || window.innerWidth;
      const h = parent.clientHeight || window.innerHeight;
      setDimensions({ width: w, height: h });
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(parent);
    handleResize();

    return () => observer.disconnect();
  }, []);

  const isPortrait = dimensions.width < dimensions.height;

  return (
    <div
      className={`ttt-root qp-sketch h-full w-full relative flex items-center justify-center overflow-hidden select-none ${isPortrait ? "p-0" : "p-1"}`}
    >
      <SketchDefs />

      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center z-10"
      >
        <PvpScene
          windowId={windowId}
          onBack={onClose}
          isPortrait={isPortrait}
        />
      </div>
    </div>
  );
}

export default function App({
  windowId,
  onClose,
}: {
  windowId: string;
  onClose: () => void;
}) {
  return (
    <CustomWalletProvider>
      <AppContent windowId={windowId} onClose={onClose} />
    </CustomWalletProvider>
  );
}
