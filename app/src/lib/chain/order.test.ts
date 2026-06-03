/**
 * Tests for the order builder: value layout (token-seller vs ADA-seller, the ADA
 * triple-role), datum correctness, and that malformed intents are rejected. Run with
 * `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOrder, type OrderIntent } from "./order.ts";
import { decodeOrderDatum, toCbor } from "./datums.ts";
import { ORDER_ADDR, ORDER_MIN_ADA } from "./deployment.ts";

const TEST_UNIT =
  "8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a54455354";
const POOL_NFT =
  "1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d04e4654";
const PKH = "ab".repeat(28);
const STAKE = "e1".repeat(28);

// asset_a = TEST, asset_b = ADA (matches the live pool orientation).
const base: OrderIntent = {
  ownerPkh: PKH,
  ownerStake: null,
  poolNftUnit: POOL_NFT,
  assetAUnit: TEST_UNIT,
  assetBUnit: "lovelace",
  sellUnit: TEST_UNIT,
  sellAmount: 100_000_000n,
  limit: 50_000_000n,
  tip: 2_000_000n,
  partial: false,
  deadline: null,
};

test("token-seller: value = min+tip lovelace + the sold token; sell_a=true", () => {
  const built = buildOrder(base);
  assert.equal(built.address, ORDER_ADDR);
  assert.deepEqual(built.value, [
    { unit: "lovelace", quantity: (ORDER_MIN_ADA + 2_000_000n).toString() },
    { unit: TEST_UNIT, quantity: "100000000" },
  ]);
  const d = decodeOrderDatum(toCbor(built.datum));
  assert.equal(d.sellA, true);
  assert.equal(d.sellAmount, 100_000_000n);
  assert.equal(d.limit, 50_000_000n);
  assert.deepEqual(d.owner, { kind: "key", hash: PKH });
  assert.equal(d.ownerStake, null); // base fixture is enterprise
});

test("base-address order carries the owner's stake credential in the datum", () => {
  const built = buildOrder({ ...base, ownerStake: { kind: "key", hash: STAKE } });
  const d = decodeOrderDatum(toCbor(built.datum));
  assert.deepEqual(d.ownerStake, { kind: "key", hash: STAKE });
  // the payout stake is independent of the order value layout.
  assert.deepEqual(built.value, [
    { unit: "lovelace", quantity: (ORDER_MIN_ADA + 2_000_000n).toString() },
    { unit: TEST_UNIT, quantity: "100000000" },
  ]);
});

test("partial order pre-funds 2× order_min_ada (remainder funding)", () => {
  // token-seller, partial
  const tokenPartial = buildOrder({ ...base, partial: true });
  assert.deepEqual(tokenPartial.value, [
    { unit: "lovelace", quantity: (ORDER_MIN_ADA * 2n + 2_000_000n).toString() },
    { unit: TEST_UNIT, quantity: "100000000" },
  ]);
  assert.equal(decodeOrderDatum(toCbor(tokenPartial.datum)).partial, true);

  // ADA-seller, partial: the second min-ADA is what keeps the owner output fundable
  const adaPartial = buildOrder({
    ...base,
    sellUnit: "lovelace",
    sellAmount: 50_000_000n,
    limit: 90_000_000n,
    partial: true,
  });
  assert.deepEqual(adaPartial.value, [
    {
      unit: "lovelace",
      quantity: (50_000_000n + ORDER_MIN_ADA * 2n + 2_000_000n).toString(),
    },
  ]);
});

test("ADA-seller: lovelace carries sell + min + tip (triple role); sell_a=false", () => {
  const built = buildOrder({
    ...base,
    sellUnit: "lovelace",
    sellAmount: 50_000_000n,
    limit: 90_000_000n,
  });
  assert.deepEqual(built.value, [
    {
      unit: "lovelace",
      quantity: (50_000_000n + ORDER_MIN_ADA + 2_000_000n).toString(),
    },
  ]);
  const d = decodeOrderDatum(toCbor(built.datum));
  assert.equal(d.sellA, false);
  assert.equal(d.sellAmount, 50_000_000n);
});

test("lovelace sizing table: (partial?2:1)×min + tip (+ sellAmount when selling ADA)", () => {
  const cases: {
    partial: boolean;
    sellAda: boolean;
    tip: bigint;
    sellAmount: bigint;
  }[] = [
    { partial: false, sellAda: false, tip: 2_000_000n, sellAmount: 100n },
    { partial: true, sellAda: false, tip: 2_000_000n, sellAmount: 100n },
    { partial: false, sellAda: true, tip: 5_000_000n, sellAmount: 50_000_000n },
    { partial: true, sellAda: true, tip: 1_000_000n, sellAmount: 7_000_000n },
    { partial: false, sellAda: false, tip: 1n, sellAmount: 1n }, // 1-lovelace tip floor
  ];
  for (const c of cases) {
    const built = buildOrder({
      ...base,
      sellUnit: c.sellAda ? "lovelace" : TEST_UNIT, // assetB is ADA, assetA is TEST
      sellAmount: c.sellAmount,
      tip: c.tip,
      partial: c.partial,
      limit: 1n,
    });
    const expectedLovelace =
      (c.partial ? 2n : 1n) * ORDER_MIN_ADA + c.tip + (c.sellAda ? c.sellAmount : 0n);
    const lovelaceEntry = built.value.find((a) => a.unit === "lovelace");
    assert.ok(lovelaceEntry, "every order value carries lovelace");
    assert.equal(lovelaceEntry.quantity, expectedLovelace.toString());

    // A token sale rides the sold token as its own asset entry; an ADA sale does not.
    const tokenEntry = built.value.find((a) => a.unit === TEST_UNIT);
    if (c.sellAda) {
      assert.equal(tokenEntry, undefined);
      assert.equal(built.value.length, 1);
    } else {
      assert.equal(tokenEntry?.quantity, c.sellAmount.toString());
      assert.equal(built.value.length, 2);
    }
  }
});

test("malformed intents are rejected (never silently posted)", () => {
  assert.throws(() => buildOrder({ ...base, sellAmount: 0n }));
  assert.throws(() => buildOrder({ ...base, limit: 0n }));
  assert.throws(() => buildOrder({ ...base, tip: -1n }));
  // a 0 tip is un-settleable (the tip is the only solver reward) → rejected
  assert.throws(() => buildOrder({ ...base, tip: 0n }));
  assert.throws(() => buildOrder({ ...base, ownerPkh: "tooshort" }));
  // malformed stake credential hash
  assert.throws(() =>
    buildOrder({ ...base, ownerStake: { kind: "key", hash: "tooshort" } }),
  );
  // sell asset not part of the pool pair
  assert.throws(() => buildOrder({ ...base, sellUnit: "deadbeef".repeat(7) }));
  // degenerate pair
  assert.throws(() => buildOrder({ ...base, assetBUnit: TEST_UNIT }));
});
