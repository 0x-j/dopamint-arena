/**
 * Regular Payments tunnel session — open on Go shop, stream A→B micro-payments on Pay now,
 * settle once, then thank-you. Kept out of React (per windowId) so minimize/reflow does not
 * abort an in-flight pay stream (ADR-0003).
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { PaymentsProtocol } from "sui-tunnel-ts/protocol/payments";
import type {
  PaymentMove,
  PaymentsState,
} from "sui-tunnel-ts/protocol/payments";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { useTelemetry } from "@/telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "@/backend/controlPlane";
import { settleViaBackend } from "@/backend/settle";
import {
  closeCooperativeWithRoot,
  readCreatedAt,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { useSponsoredSignExec } from "@/onchain/useSponsoredSignExec";
import { MTPS_COIN_TYPE, isMtpsConfigured } from "@/onchain/mtps";
import {
  configureSharedBatcher,
  requestTunnelOpen,
} from "@/onchain/sharedTunnelOpenBatcher";
import type {
  CartFlyCue,
  CartLine,
  Product,
  Screen,
  SessionPhase,
} from "../types";
import { PRODUCTS } from "../utils/catalog";
import {
  AUTO_ADD_INTERVAL_MS,
  AUTO_TARGET_CHOICES,
  DEPOSIT_B_DUST,
  DEPOSIT_BUDGET,
  MICRO_UNIT,
  STREAM_DURATION_MS,
} from "../utils/constants";
import {
  addCartLine,
  cartTotal,
  removeCartLine,
  verifyMove,
} from "../utils/sessionCore";
import { formatMtps } from "../utils";

const GAME_ID = "regular-payments";

const SETTLE_URL = (digest: string) =>
  `https://suiscan.xyz/testnet/tx/${digest}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SessionDeps {
  report: ReturnType<typeof useTelemetry>["report"];
  account: string | undefined;
  client: unknown;
  sponsoredSignExec: ReturnType<typeof useSponsoredSignExec>["signExec"];
  signExec: ReturnType<typeof useSponsoredSignExec>["signExec"];
  ensureStakeBalance: ReturnType<
    typeof useSponsoredSignExec
  >["ensureStakeBalance"];
  prepareStake: ReturnType<typeof useSponsoredSignExec>["prepareStake"];
  selectStakeCoin: ReturnType<typeof useSponsoredSignExec>["selectStakeCoin"];
}

interface RegularPaymentsSnapshot {
  screen: Screen;
  phase: SessionPhase;
  cart: CartLine[];
  balanceA: bigint;
  paidSoFar: bigint;
  payTarget: bigint;
  rollingTps: number;
  settleDigest: string | null;
  settleUrl: string | null;
  error: string | null;
  autoMode: boolean;
  autoTarget: bigint;
  cartFlyCue: CartFlyCue | null;
}

class RegularPaymentsSession {
  deps: SessionDeps | null = null;
  private gen = 0;
  private listeners = new Set<() => void>();

  private screen: Screen = "lobby";
  private phase: SessionPhase = "idle";
  private cart: CartLine[] = [];
  private balanceA = DEPOSIT_BUDGET;
  private paidSoFar = 0n;
  private payTarget = 0n;
  private rollingTps = 0;
  private settleDigest: string | null = null;
  private settleUrl: string | null = null;
  private error: string | null = null;

  private opening = false;
  private paying = false;
  private autoMode = true;
  private autoTarget = 0n;
  private autoAbort: AbortController | null = null;
  private autoLoopRunning = false;
  private lastAddMs = 0;
  private cartFlySeq = 0;
  private cartFlyCue: CartFlyCue | null = null;

  private tunnel: OffchainTunnel<PaymentsState, PaymentMove> | null = null;
  private protocol: PaymentsProtocol | null = null;
  private transcript: Transcript | null = null;
  private tunnelId = "";
  private createdAt = 0n;
  private moveTs = 1n;

  private cpSession: RegisterSessionResult | null = null;
  private moveCount = 0;
  private actions = 0;
  private lastHeartbeat = Date.now();
  private tpsWindowStart = Date.now();
  private tpsWindowSteps = 0;

  /** Cached snapshot — useSyncExternalStore requires referential stability between emits. */
  private snap: RegularPaymentsSnapshot = {
    screen: "lobby",
    phase: "idle",
    cart: [],
    balanceA: DEPOSIT_BUDGET,
    paidSoFar: 0n,
    payTarget: 0n,
    rollingTps: 0,
    settleDigest: null,
    settleUrl: null,
    error: null,
    autoMode: true,
    autoTarget: 0n,
    cartFlyCue: null,
  };

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): RegularPaymentsSnapshot => this.snap;

  private emit() {
    this.snap = {
      screen: this.screen,
      phase: this.phase,
      cart: this.cart,
      balanceA: this.balanceA,
      paidSoFar: this.paidSoFar,
      payTarget: this.payTarget,
      rollingTps: this.rollingTps,
      settleDigest: this.settleDigest,
      settleUrl: this.settleUrl,
      error: this.error,
      autoMode: this.autoMode,
      autoTarget: this.autoTarget,
      cartFlyCue: this.cartFlyCue,
    };
    for (const l of this.listeners) l();
  }

  private patch(p: Partial<RegularPaymentsSnapshot>) {
    if (p.screen !== undefined) this.screen = p.screen;
    if (p.phase !== undefined) this.phase = p.phase;
    if (p.cart !== undefined) this.cart = p.cart;
    if (p.balanceA !== undefined) this.balanceA = p.balanceA;
    if (p.paidSoFar !== undefined) this.paidSoFar = p.paidSoFar;
    if (p.payTarget !== undefined) this.payTarget = p.payTarget;
    if (p.rollingTps !== undefined) this.rollingTps = p.rollingTps;
    if (p.settleDigest !== undefined) this.settleDigest = p.settleDigest;
    if (p.settleUrl !== undefined) this.settleUrl = p.settleUrl;
    if (p.error !== undefined) this.error = p.error;
    if (p.autoMode !== undefined) this.autoMode = p.autoMode;
    if (p.autoTarget !== undefined) this.autoTarget = p.autoTarget;
    if (p.cartFlyCue !== undefined) this.cartFlyCue = p.cartFlyCue;
    this.emit();
  }

  private syncBalance() {
    if (this.tunnel) this.balanceA = this.tunnel.state.balanceA;
  }

  private flushHeartbeat(force: boolean) {
    const s = this.cpSession;
    if (!s || this.actions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeat;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.actions;
    this.actions = 0;
    this.lastHeartbeat = now;
    getControlPlaneClient()
      .sendHeartbeat(s.sessionId, s.statsToken, {
        tunnelId: this.tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[regular-payments] heartbeat failed:", e));
  }

  private bumpTps(steps: number) {
    this.tpsWindowSteps += steps;
    const now = Date.now();
    const elapsed = now - this.tpsWindowStart;
    if (elapsed >= 1000) {
      this.rollingTps = Math.round((this.tpsWindowSteps * 1000) / elapsed);
      this.tpsWindowStart = now;
      this.tpsWindowSteps = 0;
      this.patch({ rollingTps: this.rollingTps });
    }
  }

  private abandonTunnel() {
    this.tunnel = null;
    this.protocol = null;
    this.transcript = null;
    this.tunnelId = "";
    this.createdAt = 0n;
    this.moveTs = 1n;
    this.cpSession = null;
    this.moveCount = 0;
    this.actions = 0;
    this.paidSoFar = 0n;
    this.payTarget = 0n;
    this.balanceA = DEPOSIT_BUDGET;
    this.rollingTps = 0;
    this.tpsWindowStart = Date.now();
    this.tpsWindowSteps = 0;
  }

  dispose = () => {
    this.gen += 1;
    this.opening = false;
    this.paying = false;
    this.stopAutoLoop();
    this.abandonTunnel();
    this.listeners.clear();
    this.deps?.report.setActive(0);
  };

  private stopAutoLoop() {
    this.autoAbort?.abort();
    this.autoAbort = null;
  }

  private startAutoLoop() {
    if (this.autoLoopRunning || !this.autoMode || !this.deps?.account) return;
    const ac = new AbortController();
    this.autoAbort = ac;
    this.autoLoopRunning = true;
    void this.runAutoLoop(ac.signal).finally(() => {
      this.autoLoopRunning = false;
      if (this.autoAbort === ac) this.autoAbort = null;
    });
  }

  bindAutoLoop = (walletConnected: boolean) => {
    if (walletConnected && this.autoMode) {
      this.startAutoLoop();
    } else {
      this.stopAutoLoop();
    }
  };

  private randomAutoTarget(): bigint {
    return AUTO_TARGET_CHOICES[
      Math.floor(Math.random() * AUTO_TARGET_CHOICES.length)
    ]!;
  }

  private pickRandomProduct(): Product {
    return PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)]!;
  }

  private async waitForState(
    signal: AbortSignal,
    predicate: () => boolean,
    timeoutMs = 180_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (signal.aborted || !this.autoMode) return false;
      if (Date.now() > deadline) return false;
      await sleep(50);
    }
    return true;
  }

  private async runAutoLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.autoMode) {
      if (!this.deps?.account) {
        await sleep(500);
        continue;
      }

      if (
        this.screen !== "shop" ||
        this.phase === "idle" ||
        this.phase === "opening" ||
        this.phase === "error"
      ) {
        if (!this.opening && !this.paying) {
          this.goShop();
        }
        const shopReady = await this.waitForState(
          signal,
          () =>
            (this.screen === "shop" && this.phase === "shopping") ||
            this.phase === "error",
        );
        if (!shopReady) return;
        if (this.phase === "error") {
          await sleep(1000);
          continue;
        }
      }

      if (signal.aborted || !this.autoMode) return;

      const target = this.randomAutoTarget();
      this.patch({ autoTarget: target });

      while (!signal.aborted && this.autoMode && this.phase === "shopping") {
        const total = cartTotal(this.cart);
        if (total >= target) break;

        const product = this.pickRandomProduct();
        if (total + product.priceMtps > DEPOSIT_BUDGET) break;

        this.addToCart(product, true);
        await sleep(AUTO_ADD_INTERVAL_MS);
      }

      if (signal.aborted || !this.autoMode) return;

      if (this.phase === "shopping" && cartTotal(this.cart) > 0n) {
        this.payNow(true);
      }

      const thankReady = await this.waitForState(
        signal,
        () => this.screen === "thankYou" && this.phase === "idle",
      );
      if (!thankReady) return;

      const lobbyReady = await this.waitForState(
        signal,
        () => this.screen === "lobby",
      );
      if (!lobbyReady) return;

      await sleep(AUTO_ADD_INTERVAL_MS);
    }
  }

  toggleAutoMode = () => {
    if (this.autoMode) {
      this.stopAutoLoop();
      this.patch({ autoMode: false });
      return;
    }

    this.patch({ autoMode: true });
    this.startAutoLoop();
  };

  /** Back from shop — UI only; cart persists until trash or round end. */
  goLobby = () => {
    if (this.tunnel) this.syncBalance();
    this.patch({
      screen: "lobby",
      phase: this.tunnel ? "shopping" : "idle",
      paidSoFar: 0n,
      payTarget: 0n,
      rollingTps: 0,
      error: null,
      settleDigest: null,
      settleUrl: null,
      ...(this.tunnel ? { balanceA: this.balanceA } : {}),
    });
  };

  /** Thank-you → lobby — clears cart and pay state for the next trip. */
  completeRound = () => {
    this.abandonTunnel();
    this.patch({
      screen: "lobby",
      phase: "idle",
      cart: [],
      paidSoFar: 0n,
      payTarget: 0n,
      rollingTps: 0,
      error: null,
      settleDigest: null,
      settleUrl: null,
      balanceA: DEPOSIT_BUDGET,
      autoTarget: 0n,
    });
  };

  addToCart = (product: Product, fromAuto = false) => {
    if (this.phase !== "shopping") return;
    if (!this.tunnel) return;

    const now = Date.now();
    if (now - this.lastAddMs < AUTO_ADD_INTERVAL_MS) return;
    this.lastAddMs = now;

    // Check budget locally first
    if (product.priceMtps > this.tunnel.state.balanceA) {
      this.patch({ error: "Insufficient budget in your tunnel." });
      return;
    }

    // Prepare and verify move
    const move = { from: "A" as const, amount: product.priceMtps };
    const verification = verifyMove(this.tunnel.state, move, PRODUCTS);
    if (!verification.valid) {
      this.patch({ error: verification.error ?? "Invalid move." });
      return;
    }

    // Apply the off-chain tunnel step
    this.tunnel.step(move, "A", { timestamp: this.moveTs++ });
    this.syncBalance();

    const nextCart = addCartLine(this.cart, product);
    const cartFlyCue: CartFlyCue = {
      seq: ++this.cartFlySeq,
      productId: product.id,
      emoji: product.emoji,
    };

    if (!fromAuto) {
      this.stopAutoLoop();
      this.patch({
        autoMode: false,
        cart: nextCart,
        paidSoFar: (this.paidSoFar += product.priceMtps),
        cartFlyCue,
        balanceA: this.balanceA,
        error: null,
      });
      return;
    }

    this.patch({
      cart: nextCart,
      paidSoFar: (this.paidSoFar += product.priceMtps),
      cartFlyCue,
      balanceA: this.balanceA,
      error: null,
    });
  };

  removeFromCart = (productId: string) => {
    if (this.phase !== "shopping") return;
    if (!this.tunnel) return;

    // Find the item in the cart to get its price
    const line = this.cart.find((l) => l.id === productId);
    if (!line) return;

    // Prepare and verify refund move (from B to A)
    const move = { from: "B" as const, amount: line.priceMtps };
    const verification = verifyMove(this.tunnel.state, move, PRODUCTS);
    if (!verification.valid) {
      this.patch({ error: verification.error ?? "Invalid refund move." });
      return;
    }

    // Apply the off-chain refund step
    this.tunnel.step(move, "B", { timestamp: this.moveTs++ });
    this.syncBalance();

    const nextCart = removeCartLine(this.cart, productId);
    this.patch({
      cart: nextCart,
      balanceA: this.balanceA,
      error: null,
    });
  };

  goShop = () => {
    const deps = this.deps;
    if (!deps?.account) {
      this.patch({
        phase: "error",
        error: "Connect a wallet to open the shopping tunnel.",
      });
      return;
    }
    if (this.opening || this.paying) return;
    if (this.phase === "paying" || this.phase === "settling") return;

    if (this.tunnel && this.phase === "shopping") {
      this.syncBalance();
      this.patch({
        screen: "shop",
        error: null,
        paidSoFar: 0n,
        payTarget: 0n,
        balanceA: this.tunnel.state.balanceA,
      });
      return;
    }

    this.gen += 1;
    const myGen = this.gen;
    this.opening = true;
    this.abandonTunnel();
    this.patch({
      phase: "opening",
      error: null,
      settleDigest: null,
      settleUrl: null,
      paidSoFar: 0n,
      payTarget: 0n,
      rollingTps: 0,
    });

    void (async () => {
      try {
        const a = createParticipant("shopper-a");
        const b = createParticipant("shop-pos-b");
        const reads = deps.client as unknown as SuiReads;
        const partyA = { address: a.address, publicKey: a.keyPair.publicKey };
        const partyB = { address: b.address, publicKey: b.keyPair.publicKey };

        const tunnelId = await requestTunnelOpen({
          partyA,
          partyB,
          aAmount: DEPOSIT_BUDGET,
          bAmount: DEPOSIT_B_DUST,
          coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
          usesAddressBalance: true,
        });
        if (this.gen !== myGen) return;

        const createdAt = await readCreatedAt(reads, tunnelId);
        if (this.gen !== myGen) return;

        const protocol = new PaymentsProtocol();
        const tunnel = OffchainTunnel.selfPlay(
          protocol,
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: DEPOSIT_BUDGET, b: DEPOSIT_B_DUST },
        );
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u, bytes) => {
          transcript.append(u);
          this.moveCount += 1;
          this.actions += 1;
          deps.report.bumpCounters({
            updates: 1,
            signatures: 2,
            verifications: 2,
            bytes,
          });
          this.flushHeartbeat(false);
        };

        this.tunnel = tunnel;
        this.protocol = protocol;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.moveTs = 1n;
        this.cpSession = null;
        this.moveCount = 0;
        this.actions = 0;
        this.lastHeartbeat = Date.now();

        getControlPlaneClient()
          .registerSession({
            userAddress: deps.account!,
            game: "regular-payments",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
          .then((s) => {
            this.cpSession = s;
          })
          .catch((e) =>
            console.error("[regular-payments] registerSession failed:", e),
          );

        deps.report.bumpCounters({ tunnelsOpened: 1 });
        deps.report.setActive(2);
        deps.report.pushLocalTxn({
          id: 0,
          game: GAME_ID,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: "You",
          type: "Shop open",
          status: "Success",
          amount: formatMtps(DEPOSIT_BUDGET),
        });
        this.syncBalance();
        this.opening = false;
        this.patch({
          screen: "shop",
          phase: "shopping",
          balanceA: tunnel.state.balanceA,
        });
      } catch (e) {
        if (this.gen !== myGen) return;
        this.opening = false;
        deps.report.setActive(0);
        this.abandonTunnel();
        this.patch({
          phase: "error",
          screen: "lobby",
          error: String((e as Error)?.message ?? e),
        });
      }
    })();
  };

  payNow = (_fromAuto = false) => {
    const deps = this.deps;
    const tunnel = this.tunnel;
    const protocol = this.protocol;
    const transcript = this.transcript;
    if (!deps || !tunnel || !protocol || !transcript) return;
    if (this.paying || this.phase !== "shopping") return;

    const target = cartTotal(this.cart);
    if (target <= 0n) return;

    this.gen += 1;
    const myGen = this.gen;
    this.paying = true;

    this.patch({
      phase: "settling",
      payTarget: target,
      error: null,
      rollingTps: 0,
    });
    this.tpsWindowStart = Date.now();
    this.tpsWindowSteps = 0;

    void (async () => {
      try {
        this.flushHeartbeat(true);
        deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
        deps.report.setActive(0);

        const settlement = tunnel.buildSettlementWithRoot(
          this.createdAt,
          transcript.root(),
          0n,
        );
        const coinType = isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
        const digest = await settleViaBackend({
          tunnelId: this.tunnelId,
          settlement,
          transcript: transcript.rawEntries(),
          label: "regular-payments",
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

        if (this.gen !== myGen) return;

        deps.report.pushLocalTxn({
          id: 0,
          game: GAME_ID,
          digest: digest ?? undefined,
          address: deps.account,
          time: new Date().toLocaleTimeString("en-GB"),
          bot: "You",
          type: "Settled",
          status: "Success",
          amount: formatMtps(target),
        });

        this.abandonTunnel();
        this.paying = false;
        this.patch({
          screen: "thankYou",
          phase: "idle",
          cart: [...this.cart],
          paidSoFar: this.paidSoFar,
          payTarget: this.paidSoFar,
          settleDigest: digest ?? null,
          settleUrl: digest ? SETTLE_URL(digest) : null,
          balanceA: DEPOSIT_BUDGET,
        });
      } catch (e) {
        if (this.gen !== myGen) return;
        this.paying = false;
        this.syncBalance();
        this.patch({
          phase: "shopping",
          error: String((e as Error)?.message ?? e),
        });
      }
    })();
  };
}

const sessions = new Map<string, RegularPaymentsSession>();

function getSession(windowId: string): RegularPaymentsSession {
  let session = sessions.get(windowId);
  if (!session) {
    session = new RegularPaymentsSession();
    sessions.set(windowId, session);
    const created = session;
    registerWindowDisposer(windowId, "regular-payments", () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  return session;
}

export function useRegularPaymentsSession(windowId: string) {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sponsored = useSponsoredSignExec();

  const session = getSession(windowId);
  const walletSignExec = useCallback(
    async (tx: Parameters<typeof signAndExecute>[0]["transaction"]) => {
      const r = await signAndExecute({ transaction: tx });
      return { digest: r.digest };
    },
    [signAndExecute],
  );

  session.deps = {
    report,
    account: account?.address,
    client,
    sponsoredSignExec: sponsored.signExec,
    signExec: walletSignExec as never,
    ensureStakeBalance: sponsored.ensureStakeBalance,
    prepareStake: sponsored.prepareStake,
    selectStakeCoin: sponsored.selectStakeCoin,
  };

  configureSharedBatcher({
    reads: client as never,
    sponsoredSignExec: sponsored.signExec as never,
    signExec: walletSignExec as never,
    ensureStakeBalance: sponsored.ensureStakeBalance,
    prepareStake: sponsored.prepareStake,
    selectStakeCoin: sponsored.selectStakeCoin,
  });

  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => {
    session.bindAutoLoop(Boolean(account?.address));
  }, [account?.address]);

  const itemCount = snap.cart.reduce((n, l) => n + l.qty, 0);
  const cartTotalValue = cartTotal(snap.cart);
  const walletConnected = Boolean(account?.address);
  const busy =
    snap.phase === "opening" ||
    snap.phase === "paying" ||
    snap.phase === "settling";

  return {
    ...snap,
    cartTotal: cartTotalValue,
    itemCount,
    walletConnected,
    busy,
    depositBudget: DEPOSIT_BUDGET,

    goShop: session.goShop,
    goLobby: session.goLobby,
    completeRound: session.completeRound,
    payNow: session.payNow,
    addToCart: session.addToCart,
    removeFromCart: session.removeFromCart,
    toggleAutoMode: session.toggleAutoMode,
  };
}
