/**
 * Encoding/round-trip tests for the ShaSwap Plutus datum codec.
 *
 * Run with: `npm run test` (Node's built-in runner + TS type-stripping). These are
 * deliberately decoupled from the Next/tsc build (excluded in tsconfig + eslint) and
 * import the source with an explicit `.ts` specifier, which the Node runner requires.
 *
 * The golden CBOR values below are the make-or-break check: they must match
 * `contracts/plutus.json` and the batcher's pallas encoder
 * (`batcher/crates/txbuild/src/plutus.rs`). A drift here means a mis-encoded order.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADA,
  assetFromUnit,
  assetUnit,
  decodeOrderDatum,
  decodePoolDatum,
  encodeAssetId,
  encodeOrderDatum,
  encodePoolDatum,
  orderReclaimRedeemer,
  orderSettleRedeemer,
  toCbor,
  type OrderDatum,
  type PoolDatum,
} from "./datums.ts";

// A fixed sample mirroring the Rust `round_trips_through_decode` test exactly, so the
// golden CBOR is a cross-language pin against the batcher encoder.
const SAMPLE_ORDER: OrderDatum = {
  owner: { kind: "key", hash: "ab".repeat(28) },
  ownerStake: { kind: "key", hash: "e1".repeat(28) }, // base-address payout
  poolNft: { policy: "44".repeat(28), name: "4e4654" }, // "NFT"
  sellA: true,
  sellAmount: 1_000_000n,
  limit: 400_000n,
  tip: 2_000_000n,
  partial: false,
  deadline: 1000n,
};

const SAMPLE_ORDER_CBOR =
  "d8799fd8799f581cababababababababababababababababababababababababababababffd8799fd8799f581ce1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1ffffd8799f581c44444444444444444444444444444444444444444444444444444444434e4654ffd87a801a000f42401a00061a801a001e8480d87980d8799f1903e8ffff";

test("nullary redeemers match known CBOR", () => {
  assert.equal(toCbor(orderSettleRedeemer), "d87980"); // Constr 0 []
  assert.equal(toCbor(orderReclaimRedeemer), "d87a80"); // Constr 1 []
});

test("ADA AssetId encodes to d8799f4040ff", () => {
  assert.equal(toCbor(encodeAssetId(ADA)), "d8799f4040ff");
});

test("OrderDatum encodes byte-for-byte to the batcher golden CBOR", () => {
  assert.equal(toCbor(encodeOrderDatum(SAMPLE_ORDER)), SAMPLE_ORDER_CBOR);
});

test("OrderDatum round-trips through encode → decode", () => {
  const back = decodeOrderDatum(toCbor(encodeOrderDatum(SAMPLE_ORDER)));
  assert.deepEqual(back, SAMPLE_ORDER);
});

test("ADA-seller OrderDatum (sell_a=false, None deadline, enterprise) round-trips", () => {
  const o: OrderDatum = {
    owner: { kind: "key", hash: "cd".repeat(28) },
    ownerStake: null, // enterprise payout (no stake credential)
    poolNft: { policy: "ee".repeat(28), name: "4e4654" },
    sellA: false,
    sellAmount: 50_000_000n,
    limit: 90_000_000n,
    tip: 2_000_000n,
    partial: false,
    deadline: null,
  };
  assert.deepEqual(decodeOrderDatum(toCbor(encodeOrderDatum(o))), o);
});

test("OrderDatum with a SCRIPT stake credential round-trips", () => {
  const o: OrderDatum = {
    owner: { kind: "key", hash: "cd".repeat(28) },
    ownerStake: { kind: "script", hash: "e2".repeat(28) },
    poolNft: { policy: "ee".repeat(28), name: "4e4654" },
    sellA: true,
    sellAmount: 1_000_000n,
    limit: 1n,
    tip: 0n,
    partial: true,
    deadline: 1700000000000n,
  };
  assert.deepEqual(decodeOrderDatum(toCbor(encodeOrderDatum(o))), o);
});

test("PoolDatum round-trips through encode → decode", () => {
  const p: PoolDatum = {
    nft: { policy: "1c".repeat(28), name: "4e4654" },
    assetA: ADA,
    assetB: { policy: "81".repeat(28), name: "54455354" },
    feeNum: 3n,
    feeDen: 1000n,
    creator: { kind: "key", hash: "ab".repeat(28) },
  };
  assert.deepEqual(decodePoolDatum(toCbor(encodePoolDatum(p))), p);
});

test("assetUnit / assetFromUnit are inverse and reject junk", () => {
  assert.equal(assetUnit(ADA), "lovelace");
  assert.deepEqual(assetFromUnit("lovelace"), ADA);
  const unit = "81".repeat(28) + "54455354";
  assert.deepEqual(assetFromUnit(unit), {
    policy: "81".repeat(28),
    name: "54455354",
  });
  assert.equal(assetUnit(assetFromUnit(unit)), unit);
  assert.throws(() => assetFromUnit("not-hex!"));
  assert.throws(() => assetFromUnit("abcd")); // too short for a policy id
});

test("decodeOrderDatum rejects malformed input (never silently parses)", () => {
  // A bare integer is not a constructor.
  assert.throws(() => decodeOrderDatum(toCbor(42n as never)));
  // Wrong field count: PoolDatum CBOR can't be read as an OrderDatum.
  const poolCbor = toCbor(
    encodePoolDatum({
      nft: { policy: "1c".repeat(28), name: "4e4654" },
      assetA: ADA,
      assetB: { policy: "81".repeat(28), name: "54455354" },
      feeNum: 3n,
      feeDen: 1000n,
      creator: { kind: "key", hash: "ab".repeat(28) },
    }),
  );
  assert.throws(() => decodeOrderDatum(poolCbor));
});
