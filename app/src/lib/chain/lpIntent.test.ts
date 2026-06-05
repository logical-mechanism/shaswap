/**
 * Tests for the LP-intent builders: value layout (token/token vs ADA-side deposit, the ADA
 * triple-role; withdraw locks LP + min + tip), datum correctness (floors zeroed on the unused
 * side, owner_stake pinned), the enterprise (non-S) address, and that malformed intents are
 * rejected. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLpIntentDeposit,
  buildLpIntentWithdraw,
  type LpIntentDepositIntent,
  type LpIntentWithdrawIntent,
} from "./lpIntent.ts";
import { decodeLpIntentDatum, toCbor } from "./datums.ts";
import { LP_INTENT_MIN_ADA, lpUnitForPool } from "./deployment.ts";
import { lpIntentAddress } from "./lpIntentScript.ts";

const TEST_UNIT =
  "8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a54455354";
const POOL_NFT =
  "1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d04e4654";
const LP_UNIT = lpUnitForPool(POOL_NFT);
const PKH = "ab".repeat(28);
const STAKE = "e1".repeat(28);
// The active (preprod default under the runner) lp_intent enterprise address.
const LP_INTENT_ADDR = lpIntentAddress(0);

// asset_a = TEST, asset_b = ADA (matches the live pool orientation).
const depBase: LpIntentDepositIntent = {
  ownerPkh: PKH,
  ownerStake: null,
  poolNftUnit: POOL_NFT,
  assetAUnit: TEST_UNIT,
  assetBUnit: "lovelace",
  amountA: 200_000_000n, // 200 TEST
  amountB: 100_000_000n, // 100 ADA
  minShares: 90_000n,
  tip: 1_000_000n,
  deadline: null,
};

const wdBase: LpIntentWithdrawIntent = {
  ownerPkh: PKH,
  ownerStake: null,
  poolNftUnit: POOL_NFT,
  assetAUnit: TEST_UNIT,
  assetBUnit: "lovelace",
  lpAmount: 100_000n,
  minA: 19_000_000n,
  minB: 9_000_000n,
  tip: 1_000_000n,
  deadline: null,
};

// ---- deposit ----

test("deposit (ADA side B): lovelace = min + tip + ADA deposit; token rides aside", () => {
  const built = buildLpIntentDeposit(depBase);
  assert.equal(built.address, LP_INTENT_ADDR);
  assert.deepEqual(built.value, [
    {
      unit: "lovelace",
      quantity: (LP_INTENT_MIN_ADA + 1_000_000n + 100_000_000n).toString(),
    },
    { unit: TEST_UNIT, quantity: "200000000" },
  ]);
  const d = decodeLpIntentDatum(toCbor(built.datum));
  assert.equal(d.action, "deposit");
  assert.equal(d.minShares, 90_000n);
  assert.equal(d.minA, 0n); // unused side zeroed
  assert.equal(d.minB, 0n);
  assert.equal(d.tip, 1_000_000n);
  assert.deepEqual(d.owner, { kind: "key", hash: PKH });
  assert.equal(d.ownerStake, null);
});

test("deposit (token/token): lovelace = min + tip only; both tokens ride aside", () => {
  const HOSKY =
    "00000000000000000000000000000000000000000000000000000001484f534b59";
  const built = buildLpIntentDeposit({
    ...depBase,
    assetBUnit: HOSKY,
    amountB: 500_000_000n,
  });
  assert.deepEqual(built.value, [
    { unit: "lovelace", quantity: (LP_INTENT_MIN_ADA + 1_000_000n).toString() },
    { unit: TEST_UNIT, quantity: "200000000" },
    { unit: HOSKY, quantity: "500000000" },
  ]);
});

test("deposit carries the owner's stake credential (base-address payout)", () => {
  const built = buildLpIntentDeposit({
    ...depBase,
    ownerStake: { kind: "key", hash: STAKE },
  });
  const d = decodeLpIntentDatum(toCbor(built.datum));
  assert.deepEqual(d.ownerStake, { kind: "key", hash: STAKE });
});

// ---- withdraw ----

test("withdraw: value = (min + tip) lovelace + L LP; floors set, min_shares zeroed", () => {
  const built = buildLpIntentWithdraw(wdBase);
  assert.equal(built.address, LP_INTENT_ADDR);
  assert.deepEqual(built.value, [
    { unit: "lovelace", quantity: (LP_INTENT_MIN_ADA + 1_000_000n).toString() },
    { unit: LP_UNIT, quantity: "100000" },
  ]);
  const d = decodeLpIntentDatum(toCbor(built.datum));
  assert.equal(d.action, "withdraw");
  assert.equal(d.minA, 19_000_000n);
  assert.equal(d.minB, 9_000_000n);
  assert.equal(d.minShares, 0n); // unused for withdraw
});

test("withdraw allows a one-sided floor (the other reserve may be tiny)", () => {
  const a = buildLpIntentWithdraw({ ...wdBase, minB: 0n });
  assert.equal(decodeLpIntentDatum(toCbor(a.datum)).minB, 0n);
  const b = buildLpIntentWithdraw({ ...wdBase, minA: 0n });
  assert.equal(decodeLpIntentDatum(toCbor(b.datum)).minA, 0n);
});

// ---- owner is always a VK + malformed rejection ----

test("intent owner is ALWAYS a verification-key credential (reclaimable)", () => {
  for (const stake of [null, { kind: "key" as const, hash: STAKE }]) {
    const dd = decodeLpIntentDatum(
      toCbor(buildLpIntentDeposit({ ...depBase, ownerStake: stake }).datum),
    );
    assert.equal(dd.owner.kind, "key");
    const wd = decodeLpIntentDatum(
      toCbor(buildLpIntentWithdraw({ ...wdBase, ownerStake: stake }).datum),
    );
    assert.equal(wd.owner.kind, "key");
  }
});

test("malformed deposit intents are rejected (never silently posted)", () => {
  assert.throws(() => buildLpIntentDeposit({ ...depBase, amountA: 0n }));
  assert.throws(() => buildLpIntentDeposit({ ...depBase, amountB: 0n }));
  assert.throws(() => buildLpIntentDeposit({ ...depBase, minShares: 0n })); // no floor
  assert.throws(() => buildLpIntentDeposit({ ...depBase, tip: 0n })); // un-fulfillable
  assert.throws(() => buildLpIntentDeposit({ ...depBase, tip: -1n }));
  assert.throws(() => buildLpIntentDeposit({ ...depBase, ownerPkh: "tooshort" }));
  assert.throws(() =>
    buildLpIntentDeposit({ ...depBase, ownerStake: { kind: "key", hash: "short" } }),
  );
  assert.throws(() => buildLpIntentDeposit({ ...depBase, assetBUnit: TEST_UNIT })); // degenerate pair
  assert.throws(() => buildLpIntentDeposit({ ...depBase, deadline: 0n }));
});

test("malformed withdraw intents are rejected (never silently posted)", () => {
  assert.throws(() => buildLpIntentWithdraw({ ...wdBase, lpAmount: 0n }));
  assert.throws(() => buildLpIntentWithdraw({ ...wdBase, minA: 0n, minB: 0n })); // no floor at all
  assert.throws(() => buildLpIntentWithdraw({ ...wdBase, minA: -1n }));
  assert.throws(() => buildLpIntentWithdraw({ ...wdBase, tip: 0n }));
  assert.throws(() => buildLpIntentWithdraw({ ...wdBase, ownerPkh: "zz".repeat(28) }));
});
