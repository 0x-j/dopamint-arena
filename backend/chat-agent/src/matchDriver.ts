import type { OllamaBackendClient } from "./ollama.ts";
import type { MpChannel } from "./mpClient.ts";
import type {
  ChatMessage,
  StatefulChatProtocol,
} from "sui-tunnel-ts/protocol/chat";

export interface ChatDriverDeps {
  ollama: OllamaBackendClient;
  channel: MpChannel;
  protocol: StatefulChatProtocol;
  tunnelId: string;
  botName: string;
}

export class ChatMatchDriver {
  private channel: MpChannel;
  private protocol: StatefulChatProtocol;
  private ollama: OllamaBackendClient;
  private tunnelId: string;
  private botName: string;
  private running = false;
  private stopRequested = false;
  private movesSent = 0;
  private readonly maxMoves = 6;

  constructor(
    channel: MpChannel,
    protocol: StatefulChatProtocol,
    ollama: OllamaBackendClient,
    tunnelId: string,
    botName: string,
  ) {
    this.channel = channel;
    this.protocol = protocol;
    this.ollama = ollama;
    this.tunnelId = tunnelId;
    this.botName = botName;
  }

  async start(topic: string): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    this.channel.sendPeer({ t: "opened", tunnelId: this.tunnelId });

    this.channel.onPeer((msg) => this.handlePeer(msg));
    this.channel.transport.onFrame((bytes) => this.protocol.applyMove(bytes));

    void this.runLoop(topic);
  }

  private async runLoop(topic: string): Promise<void> {
    const protocol = this.protocol;
    while (this.running && !this.stopRequested) {
      const ourTurn = protocol.ourTurn();
      const terminal = protocol.isTerminal();
      if (ourTurn && !terminal && this.movesSent < this.maxMoves) {
        const history = protocol.stateAsChat().messages.map((m) => ({
          sender: m.sender,
          text: m.text,
        }));
        const answer = await this.ollama.chat([
          {
            role: "system",
            content: `You are ${this.botName}. Stay on topic.`,
          },
          {
            role: "user",
            content: `Topic: ${topic}\nChat so far:\n${
              history.map((m) => `${m.sender}: ${m.text}`).join("\n") ||
              "(empty)"
            }\nReply briefly.`,
          },
        ]);
        const move = protocol.createMove(answer);
        protocol.applyMove(move);
        this.channel.transport.send(move);
        this.movesSent += 1;
      }
      // Tight poll: act on our turn ASAP (reply latency is bounded by Ollama).
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private handlePeer(msg: { t: string; tunnelId?: string }): void {
    if (msg.t === "opened" && msg.tunnelId) {
      // opponent announced their tunnel; already queued our own on start.
    } else if (msg.t === "settle") {
      this.stopRequested = true;
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
  }

  requestStop(): void {
    this.stopRequested = true;
  }

  snapshot(): { messages: ChatMessage[] } {
    return this.protocol.stateAsChat();
  }
}
