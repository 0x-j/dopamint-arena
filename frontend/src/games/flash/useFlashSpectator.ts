import { useEffect, useRef, useState } from "react";
import { FlashApiClient, type FlashLiveMessage } from "./flashApi";

// The loop streams hundreds of moves/sec. A React update per message would saturate the main thread,
// and an unbounded list would grow the DOM + memory without limit. So we keep only a recent window
// and flush it on a fixed cadence — render cost stays constant regardless of the move count.
const MAX_SHOWN = 120;
const FLUSH_MS = 100; // ~10 renders/sec instead of one per message

export function useFlashSpectator() {
  const apiRef = useRef<FlashApiClient | null>(null);
  const api = apiRef.current ?? (apiRef.current = new FlashApiClient());
  const [messages, setMessages] = useState<FlashLiveMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef<FlashLiveMessage[]>([]);
  // Set when the user clicks Stop; suppresses stream-based "running" inference so a single Stop wins.
  const userStoppedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    // Sync to the backend's actual loop state on open: it's one server-side loop, so another tab or
    // session may already have it running — the buttons must reflect that, not this tab's history.
    void api
      .status()
      .then((s) => {
        if (alive) setRunning(s.running);
      })
      .catch(() => {});
    const unsub = api.subscribeLive(
      (m) => {
        // Cheap ref append — no setState per message. Cap the buffer too so a backgrounded tab
        // (whose flusher is throttled) can't accumulate without bound.
        const buf = bufferRef.current;
        buf.push(m);
        if (buf.length > MAX_SHOWN) buf.splice(0, buf.length - MAX_SHOWN);
        // Infer "running" from the stream, EXCEPT once the user has stopped: the backend halts the
        // loop at once, but the SSE keeps draining its buffered backlog for a beat — without this
        // guard those stragglers flip `running` back to true and Stop appears to need a second press.
        if (!userStoppedRef.current) setRunning(true);
      },
      () => setError("live feed disconnected"),
    );
    // Batch buffered messages into React ~10x/sec and keep only the recent window.
    const flush = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      setMessages((prev) => {
        const merged = prev.concat(bufferRef.current);
        bufferRef.current = [];
        return merged.length > MAX_SHOWN ? merged.slice(-MAX_SHOWN) : merged;
      });
    }, FLUSH_MS);
    return () => {
      alive = false;
      clearInterval(flush);
      unsub();
    };
  }, [api]);

  const start = async () => {
    userStoppedRef.current = false; // re-enable stream-based "running" inference
    try {
      await api.start();
      setRunning(true);
      setError(null);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };
  const stop = async () => {
    userStoppedRef.current = true; // make Stop authoritative against draining stragglers
    try {
      await api.stop();
      setRunning(false);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  return { messages, running, error, start, stop };
}
