/**
 * Tests for the close-pool helpers: one-shot SEED RECOVERY from the mint tx's inputs
 * (the seed isn't stored in the datum) and the seed-applied burn policy. The seed →
 * policyId mapping is the same ground truth cross-checked against aiken+cardano-cli in
 * createPool.test.ts (seed `(77×32)#3` → `d695abfe…0838`, post-audit pool_mint). Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClosePool, recoverSeed } from "./closePool.ts";
import { closePoolRedeemer, mintCloseRedeemer, toCbor } from "./datums.ts";
import { LP_NAME_HEX, NFT_NAME_HEX } from "./deployment.ts";

const POLICY = "d695abfe998273ddf9724adcea4f43303f84167a47a1f30569060838";
const NFT_UNIT = POLICY + NFT_NAME_HEX;
const SEED = { txHash: "77".repeat(32), index: 3 };
const PKH = "c0".repeat(28);

// Decoys: a different txid, and the SAME txid at a different index (distinct policy).
const DECOYS = [
  { txHash: "11".repeat(32), index: 0 },
  { txHash: "77".repeat(32), index: 4 },
];

test("recoverSeed finds the mint-tx input that reproduces the pool's policy id", () => {
  assert.deepEqual(recoverSeed(NFT_UNIT, [...DECOYS, SEED]), SEED);
  assert.deepEqual(recoverSeed(NFT_UNIT, [SEED, ...DECOYS]), SEED); // order-independent
});

test("recoverSeed throws when no candidate matches (never guesses)", () => {
  assert.throws(() => recoverSeed(NFT_UNIT, DECOYS));
  assert.throws(() => recoverSeed(NFT_UNIT, []));
});

test("buildClosePool: seed-applied policy id matches the pool; NFT/LP units derived", () => {
  const built = buildClosePool({ nftUnit: NFT_UNIT, seed: SEED, creatorPkh: PKH });
  assert.equal(built.policyId, POLICY);
  assert.equal(built.nftUnit, POLICY + NFT_NAME_HEX);
  assert.equal(built.lpUnit, POLICY + LP_NAME_HEX);
  assert.ok(built.script.length > 0);
});

test("buildClosePool rejects a non-VK / malformed creator and a wrong seed", () => {
  assert.throws(() =>
    buildClosePool({ nftUnit: NFT_UNIT, seed: SEED, creatorPkh: "tooshort" }),
  );
  assert.throws(() =>
    buildClosePool({ nftUnit: NFT_UNIT, seed: SEED, creatorPkh: "zz".repeat(28) }),
  );
  // a seed that does NOT reproduce this pool's policy must throw (the sanity gate)
  assert.throws(() =>
    buildClosePool({
      nftUnit: NFT_UNIT,
      seed: { txHash: "77".repeat(32), index: 4 },
      creatorPkh: PKH,
    }),
  );
});

test("close redeemers: pool ClosePool = Constr 2 [] (d87b80), mint Close = Constr 1 [] (d87a80)", () => {
  assert.equal(toCbor(closePoolRedeemer), "d87b80");
  assert.equal(toCbor(mintCloseRedeemer), "d87a80");
});
