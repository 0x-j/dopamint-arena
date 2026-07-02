import { resolveBackendUrl } from "@/backend/controlPlane";

export interface FlashLiveMessage {
  sender: string; // "A" | "B"
  text: string;
  moveNo: number;
}

export class FlashApiClient {
  private baseUrl: string;
  private fetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string = resolveBackendUrl(),
    fetchImpl: typeof globalThis.fetch = (url, init) =>
      globalThis.fetch(url, init),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  subscribeLive(
    onMessage: (m: FlashLiveMessage) => void,
    onError?: (e: Event) => void,
  ): () => void {
    const es = new EventSource(`${this.baseUrl}/v1/flash/live`);
    es.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data) as FlashLiveMessage);
      } catch {
        /* skip */
      }
    };
    es.onerror = (e) => {
      console.error("flash live sse error", e);
      onError?.(e);
    };
    return () => es.close();
  }

  /** The backend's single self-play loop is shared across tabs/sessions; query its actual running
   *  state so the Spectator controls are correct even when opening onto an already-running loop. */
  async status(): Promise<{ running: boolean }> {
    const r = await this.fetch(`${this.baseUrl}/v1/flash/status`, {
      method: "GET",
    });
    if (!r.ok) throw new Error(`flash status failed: ${r.status}`);
    return (await r.json()) as { running: boolean };
  }

  async start(): Promise<void> {
    const r = await this.fetch(`${this.baseUrl}/v1/flash/start`, {
      method: "POST",
    });
    if (!r.ok) throw new Error(`flash start failed: ${r.status}`);
  }

  async stop(): Promise<void> {
    const r = await this.fetch(`${this.baseUrl}/v1/flash/stop`, {
      method: "POST",
    });
    if (!r.ok) throw new Error(`flash stop failed: ${r.status}`);
  }
}
