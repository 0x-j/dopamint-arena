import test from "node:test";
import assert from "node:assert/strict";
import type {
  BlackjackState,
  BlackjackSlotSecret,
} from "sui-tunnel-ts/protocol/blackjack";
import { BlackjackSecretStore } from "./blackjackSecretStore";

// The store only reads (round, drawCount, localSecret{A,B}); a minimal cast is enough.
const stateWith = (
  round: bigint,
  drawCount: bigint,
  localSecretA: BlackjackSlotSecret | null,
): BlackjackState =>
  ({
    round,
    drawCount,
    localSecretA,
    localSecretB: null,
  }) as unknown as BlackjackState;

const secret = (): BlackjackSlotSecret => ({
  value: Uint8Array.of(1, 2, 3),
  salt: Uint8Array.of(4, 5),
});

// The live reconnect stall in blackjack: a resync `adoptCheckpoint` wipes `state.localSecret`, which
// the reveal AND the persist read — so the in-flight draw can't reveal and the record records null.
// The store holds the minted secret so it survives the strip: `own` still returns it, and `anchorInto`
// puts it back into state so the reveal (`randomMove`) reads it.
test("blackjack secret store: an adopt that strips state does not lose the draw secret", () => {
  const store = new BlackjackSecretStore("A");
  const s = secret();
  const st = stateWith(24n, 3n, s);

  // The seat committed: state holds the secret; reading it warms the store.
  assert.deepEqual(store.own(st), s);

  // A resync adopt swaps in the peer's PUBLIC state — our secret is stripped.
  st.localSecretA = null;

  // The store still has it (adopt-proof), and re-anchors it so the reveal can read state again.
  assert.deepEqual(store.own(st), s, "own() survives the strip");
  store.anchorInto(st);
  assert.deepEqual(
    st.localSecretA,
    s,
    "anchorInto repopulates state for the reveal",
  );
});

test("blackjack secret store: a stale secret from a previous draw is never reused", () => {
  const store = new BlackjackSecretStore("A");
  store.remember(stateWith(1n, 0n, null), secret());
  // A later draw (different round/drawCount) with no state secret must NOT get the old one.
  assert.equal(store.own(stateWith(1n, 1n, null)), null);
  assert.equal(store.own(stateWith(2n, 0n, null)), null);
});
