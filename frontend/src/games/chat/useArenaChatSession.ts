import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import type { ChatMove, ChatStateData } from "sui-tunnel-ts/protocol/chat";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { createChatApiClient } from "@/lib/chatApi";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import type { TelemetryWriter } from "@/telemetry/TelemetryProvider";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { settleViaBackend } from "@/backend/settle";
import {
  closeCooperativeWithRoot,
  openAndFundSelfPlay,
  readCreatedAt,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { withSponsorFallback } from "@/onchain/sponsor";
import {
  MTPS_COIN_TYPE,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "@/onchain/mtps";
import {
  createChatProtocol,
  toChatApiMessages,
  type ChatMessage,
  type ChatSessionStatus,
} from "./session-core";

/** DOPAMINT bank locked per seat (1 DOPAMINT, 9 decimals). */
const LOCKED_PER_SEAT = 1_000_000_000n;
/** SUI-fallback bank per seat (MIST), when the DOPAMINT env is unset. */
const SUI_PER_SEAT = 500n;

/** You always sit in party A; party B is the local bot. */
const HUMAN_SEAT = "A" as const;

export interface ChatStats {
  updates: number;
  signatures: number;
  verifications: number;
  bytes: number;
}

export interface ArenaChatSession {
  status: ChatSessionStatus;
  messages: ChatMessage[];
  topic: string;
  error: string | null;
  canSend: boolean;
  stats: ChatStats;
  txDigest: string | null;
  start: () => void;
  send: (text: string) => void;
  settleNow: () => void;
  reset: () => void;
}

/** React-supplied capabilities, refreshed each render (wallet may connect later). */
interface ChatDeps {
  report: TelemetryWriter;
  account: { address: string } | null;
  client: unknown;
  signExec: (tx: never) => Promise<{ digest: string }>;
  sponsoredSignExec: (tx: never) => Promise<{ digest: string }>;
  selectStakeCoin: (minAmount: bigint) => Promise<string>;
  prepareStake: (minAmount: bigint) => Promise<string>;
  ensureStakeBalance: (minAmount: bigint) => Promise<void>;
}

interface ChatSnapshot {
  status: ChatSessionStatus;
  messages: ChatMessage[];
  topic: string;
  error: string | null;
  canSend: boolean;
  stats: ChatStats;
  txDigest: string | null;
}

/**
 * The solo Chat session: one wallet-funded self-play tunnel where the human (A) and
 * a backend-backed bot (B) take turns sending messages. Kept OUT of React so it survives
 * window minimize / maximize / reflow; only an explicit window close disposes it.
 */
class ChatSession {
  deps: ChatDeps | null = null;

  private status: ChatSessionStatus = "idle";
  private messages: ChatMessage[] = [];
  private topic = "";
  private error: string | null = null;
  private snap: ChatSnapshot = {
    status: "idle",
    messages: [],
    topic: "",
    error: null,
    canSend: false,
    stats: { updates: 0, signatures: 0, verifications: 0, bytes: 0 },
    txDigest: null,
  };
  private listeners = new Set<() => void>();

  private tunnel: OffchainTunnel<ChatStateData, ChatMove> | null = null;
  private transcript: Transcript | null = null;
  private tunnelId = "";
  private createdAt = 0n;
  private settleRequested = false;
  private starting = false;
  private gen = 0;
  private stats: ChatStats = {
    updates: 0,
    signatures: 0,
    verifications: 0,
    bytes: 0,
  };
  private txDigest: string | null = null;

  private api = createChatApiClient();
  private sessionId?: string;
  private statsToken?: string;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): ChatSnapshot => this.snap;

  private emit() {
    const lastSender = this.messages.at(-1)?.sender ?? null;
    this.snap = {
      status: this.status,
      messages: this.messages,
      topic: this.topic,
      error: this.error,
      canSend:
        this.status === "playing" &&
        !this.settleRequested &&
        lastSender !== "You",
      stats: { ...this.stats },
      txDigest: this.txDigest,
    };
    for (const l of this.listeners) l();
  }

  private setStatus(s: ChatSessionStatus) {
    this.status = s;
    this.emit();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  reset = () => {
    this.gen += 1;
    this.starting = false;
    this.settleRequested = false;
    this.tunnel = null;
    this.transcript = null;
    this.tunnelId = "";
    this.createdAt = 0n;
    this.messages = [];
    this.topic = "";
    this.error = null;
    this.stats = { updates: 0, signatures: 0, verifications: 0, bytes: 0 };
    this.txDigest = null;
    this.sessionId = undefined;
    this.statsToken = undefined;
    this.api.setSession(undefined, undefined);
    this.deps?.report.setActive(0);
    this.status = "idle";
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.deps?.report.setActive(0);
    this.tunnel = null;
    this.transcript = null;
    this.sessionId = undefined;
    this.statsToken = undefined;
    this.api.setSession(undefined, undefined);
    this.listeners.clear();
  };

  start = () => {
    const deps = this.deps;
    if (!deps) return;
    // Solo play is on-chain only: a connected wallet funds + settles the self-play tunnel.
    if (!deps.account) {
      this.error = "connect a wallet to stake the tunnel";
      this.status = "error";
      this.emit();
      return;
    }
    // Only a fresh/idle session may start.
    if (this.starting || this.status !== "idle") return;
    this.starting = true;
    this.gen += 1;
    const myGen = this.gen;
    this.error = null;
    this.messages = [];
    this.topic = "";
    this.settleRequested = false;
    this.emit();

    const a = createParticipant("chat-a");
    const b = createParticipant("chat-b");

    void (async () => {
      try {
        const fundedPerSeat = isMtpsConfigured ? LOCKED_PER_SEAT : SUI_PER_SEAT;

        const reads = deps.client as unknown as Parameters<
          typeof openAndFundSelfPlay
        >[0]["reads"];
        this.setStatus("funding");
        const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
        const partyB = { address: b.address, publicKey: b.keyPair.publicKey };

        // DOPAMINT path: stake a user-owned DOPAMINT coin, sponsored gas first with a wallet-pays
        // fallback (the local backend settler may be unfunded). SUI path: same pattern.
        const stakeCoinId =
          isMtpsConfigured && !isMtpsAddressBalance
            ? await deps.prepareStake(2n * fundedPerSeat)
            : undefined;
        if (isMtpsConfigured && isMtpsAddressBalance)
          await deps.ensureStakeBalance(2n * fundedPerSeat);

        const tunnelId = isMtpsConfigured
          ? await withSponsorFallback(
              async () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: deps.sponsoredSignExec as never,
                  partyA,
                  partyB,
                  aAmount: fundedPerSeat,
                  bAmount: fundedPerSeat,
                  coinType: MTPS_COIN_TYPE,
                  ...(isMtpsAddressBalance
                    ? {
                        stakeFromBalance: {
                          amount: 2n * fundedPerSeat,
                          coinType: MTPS_COIN_TYPE,
                        },
                      }
                    : { stakeCoinId: stakeCoinId! }),
                }),
              async () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: deps.signExec as never,
                  partyA,
                  partyB,
                  aAmount: fundedPerSeat,
                  bAmount: fundedPerSeat,
                  coinType: MTPS_COIN_TYPE,
                  stakeCoinId: stakeCoinId!,
                }),
              "chat open/fund",
            )
          : await withSponsorFallback(
              async () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: deps.sponsoredSignExec as never,
                  partyA,
                  partyB,
                  aAmount: fundedPerSeat,
                  bAmount: fundedPerSeat,
                  stakeCoinId: await deps.selectStakeCoin(2n * fundedPerSeat),
                }),
              () =>
                openAndFundSelfPlay({
                  reads,
                  signExec: deps.signExec as never,
                  partyA,
                  partyB,
                  aAmount: fundedPerSeat,
                  bAmount: fundedPerSeat,
                }),
              "chat open/fund",
            );
        const createdAt = await readCreatedAt(reads, tunnelId);

        const protocol = createChatProtocol(tunnelId);
        const tunnel = OffchainTunnel.selfPlay(
          protocol,
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: fundedPerSeat, b: fundedPerSeat },
        );
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u, bytes) => {
          transcript.append(u);
          this.stats.updates += 1;
          this.stats.signatures += 2;
          this.stats.verifications += 2;
          this.stats.bytes += bytes;
          this.emit();
          this.deps?.report.bumpCounters({
            updates: 1,
            signatures: 2,
            verifications: 2,
            bytes,
          });
        };

        if (this.gen !== myGen) return;
        this.tunnel = tunnel;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;

        // Register the on-chain tunnel for control-plane TPS stats and obtain the
        // bearer token for backend-proxy chat auth. In backend-proxy mode this is
        // required; in Ollama-direct mode the result is unused but harmless.
        let registration: { sessionId: string; statsToken: string } | null =
          null;
        try {
          registration = await getControlPlaneClient().registerSession({
            userAddress: a.address,
            game: "chat",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          });
        } catch (e) {
          console.error("[chat] registerSession failed:", e);
          if (!import.meta.env.VITE_OLLAMA_URL) {
            throw new Error("chat registration failed; please try again");
          }
        }
        if (this.gen !== myGen) return;
        if (registration) {
          this.sessionId = registration.sessionId;
          this.statsToken = registration.statsToken;
          this.api.setSession(registration.sessionId, registration.statsToken);
        }

        this.deps?.report.bumpCounters({ tunnelsOpened: 1 });
        this.deps?.report.setActive(2);
        this.starting = false;

        const topic = await this.api.topic();
        if (this.gen !== myGen) return;
        this.topic = topic;
        this.setStatus("playing");
      } catch (e) {
        if (this.gen !== myGen) return;
        this.starting = false;
        this.deps?.report.setActive(0);
        this.fail(e);
      }
    })();
  };

  send = async (text: string) => {
    const tunnel = this.tunnel;
    if (!tunnel || this.status !== "playing" || this.settleRequested) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // Not the human's turn (lastSender === "A" means B must reply next).
    if (tunnel.state.lastSender === HUMAN_SEAT) return;

    const myGen = this.gen;
    tunnel.step({ kind: "msg", text: trimmed }, HUMAN_SEAT);
    this.messages = [...this.messages, { sender: "You", text: trimmed }];
    this.emit();

    try {
      const history = toChatApiMessages(this.messages);
      const topicHint = this.topic
        ? `The current topic is "${this.topic}". Stay on topic and reply concisely.`
        : "Reply concisely.";
      const reply = await this.api.chat([
        {
          role: "system",
          content: `You are a brief chat bot. ${topicHint}`,
        },
        ...history,
      ]);
      if (this.gen !== myGen || this.settleRequested) return;
      tunnel.step({ kind: "msg", text: reply }, "B");
      this.messages = [...this.messages, { sender: "Bot", text: reply }];
      this.emit();
    } catch (e) {
      if (this.gen !== myGen) return;
      this.error = String((e as Error)?.message ?? e);
      this.emit();
    }
  };

  /** Settle + close the tunnel NOW at the current co-signed state. */
  private settle = async () => {
    const tunnel = this.tunnel;
    if (!tunnel || !this.deps) {
      this.setStatus("settled");
      return;
    }
    this.setStatus("settling");
    this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
    this.deps.report.setActive(0);
    try {
      const deps = this.deps;
      const transcript = this.transcript;
      const settlement = tunnel.buildSettlementWithRoot(
        this.createdAt,
        transcript ? transcript.root() : new Uint8Array(32),
        0n,
      );
      const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
      const digest = await settleViaBackend({
        tunnelId: this.tunnelId,
        settlement,
        transcript: transcript ? transcript.rawEntries() : [],
        label: "chat",
        fallbackClose: () =>
          closeCooperativeWithRoot({
            signExec: (isMtpsConfigured
              ? deps.sponsoredSignExec
              : deps.signExec) as never,
            tunnelId: this.tunnelId,
            settlement,
            coinType,
          }),
      });
      this.txDigest = digest ?? null;
      this.setStatus("settled");
    } catch (e) {
      this.fail(e);
    }
  };

  settleNow = () => {
    if (this.status !== "playing") return;
    this.settleRequested = true;
    this.emit();
    void this.settle();
  };
}

const chatSessions = new Map<string, ChatSession>();

function getChatSession(windowId: string): ChatSession {
  let session = chatSessions.get(windowId);
  if (!session) {
    session = new ChatSession();
    chatSessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "chat-session", () => {
      created.dispose();
      chatSessions.delete(windowId);
    });
  }
  return session;
}

export function useArenaChatSession(windowId: string): ArenaChatSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getChatSession(windowId);
  session.deps = {
    report,
    account,
    client,
    signExec: (async (
      tx: Parameters<typeof signAndExecute>[0]["transaction"],
    ) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    }) as never,
    sponsoredSignExec: sponsored.signExec as never,
    selectStakeCoin: sponsored.selectStakeCoin,
    prepareStake: sponsored.prepareStake,
    ensureStakeBalance: sponsored.ensureStakeBalance,
  };

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    status: snap.status,
    messages: snap.messages,
    topic: snap.topic,
    error: snap.error,
    canSend: snap.canSend,
    stats: snap.stats,
    txDigest: snap.txDigest,
    start: session.start,
    send: session.send,
    settleNow: session.settleNow,
    reset: session.reset,
  };
}
