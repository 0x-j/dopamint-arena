import { useEffect, useRef, useState } from "react";
import type { GameWindowProps } from "../types";
import { SketchDefs } from "../sketch";
import { FlashMessage } from "./components/FlashMessage";
import { FlashInput } from "./components/FlashInput";
import { canSend } from "./session-core";
import { useFlashPvp } from "./useFlashPvp";
import { useFlashSpectator } from "./useFlashSpectator";
import "./flash.css";

/** Auto-scroll a message container to the bottom whenever its deps change. */
function useScrollToBottom<T>(deps: T[]) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, deps);
  return ref;
}

export function FlashWindow({ windowId }: GameWindowProps) {
  const [tab, setTab] = useState<"play" | "spectator">("play");
  return (
    <div className="flash-root">
      <SketchDefs />
      <div className="flash-tabs">
        <button
          className={`flash-btn${tab === "play" ? "" : " flash-btn--ghost"}`}
          onClick={() => setTab("play")}
        >
          Play
        </button>
        <button
          className={`flash-btn${tab === "spectator" ? "" : " flash-btn--ghost"}`}
          onClick={() => setTab("spectator")}
        >
          Spectator
        </button>
      </div>
      {tab === "play" ? (
        <PlayTab windowId={windowId} />
      ) : (
        <SpectatorTab windowId={windowId} />
      )}
    </div>
  );
}

function PlayTab({ windowId }: { windowId: string }) {
  const {
    status,
    messages,
    error,
    state,
    selfParty,
    send,
    start,
    endChat,
    reset,
    newChat,
  } = useFlashPvp(windowId);
  const [input, setInput] = useState("");
  const bodyRef = useScrollToBottom([messages, status]);
  const playing = status === "playing";
  const canSendNow = playing && (state ? canSend(state, selfParty) : true);
  const onSend = () => {
    if (input.trim()) {
      send(input);
      setInput("");
    }
  };
  return (
    <>
      <div className="flash-head">
        <span>
          {status === "idle" ? "Flash — vs bot" : `vs bot · ${status}`}
        </span>
        {playing && (
          <button className="flash-btn flash-btn--stop" onClick={endChat}>
            End chat
          </button>
        )}
        {!playing && !["idle", "joining"].includes(status) && (
          <button className="flash-btn" onClick={newChat}>
            New Chat
          </button>
        )}
      </div>
      <div className="flash-body" ref={bodyRef}>
        {error && <div style={{ color: "var(--sketch-red)" }}>{error}</div>}
        {status === "idle" && (
          <div className="flash-idle">
            <button className="flash-btn" onClick={start}>
              Start Chat
            </button>
          </div>
        )}
        {status === "joining" && (
          <div className="flash-idle">
            <p>Allocating a bot and funding the tunnel…</p>
            <button className="flash-btn flash-btn--ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        )}
        {messages.map((m, i) => (
          <FlashMessage
            key={`${m.sender}-${i}`}
            sender={m.sender}
            text={m.text}
            isMe={m.sender === "You"}
          />
        ))}
      </div>
      <FlashInput
        value={input}
        onChange={setInput}
        onSend={onSend}
        sendDisabled={!canSendNow}
      />
    </>
  );
}
function SpectatorTab(_props: { windowId: string }) {
  const { messages, running, error, start, stop } = useFlashSpectator();
  const bodyRef = useScrollToBottom([messages]);
  const last = messages.at(-1);
  return (
    <>
      <div className="flash-head">
        <span>Bot vs Bot</span>
        <span className="flash-counter">
          {last
            ? `move #${last.moveNo.toLocaleString()} · ${messages.length} shown`
            : "idle"}
        </span>
      </div>
      <div className="flash-body" ref={bodyRef}>
        {error && <div style={{ color: "var(--sketch-red)" }}>{error}</div>}
        {messages.length === 0 && <p>Press Start to watch two bots chat.</p>}
        {messages.map((m) => (
          <FlashMessage
            key={`${m.sender}-${m.moveNo}`}
            sender={m.sender}
            text={m.text}
            isMe={m.sender === "B"}
          />
        ))}
      </div>
      <div className="flash-foot">
        <button className="flash-btn" disabled={running} onClick={start}>
          Start
        </button>
        <button
          className="flash-btn flash-btn--stop"
          disabled={!running}
          onClick={stop}
        >
          Stop
        </button>
      </div>
    </>
  );
}
