/**
 * Tests for the pool-creation builder: the per-seed policy id (cross-checked byte-for-byte
 * against the contract toolchain), the `{NFT:1, LP:total_lp}` mint + inline `PoolDatum`
 * value/datum layout (mirroring `mint_test.ak`'s `create_ok`), `applyParamsToScript`
 * determinism, the new mint redeemers, and that malformed intents are rejected. Run with
 * `npm run test`.
 *
 * GROUND-TRUTH FIXTURE: for the fixed seed `(txid = 77×32, index = 3)` — the same seed as
 * `mint_test.ak`'s `seed()` — the per-pool policy id was computed via
 *   `aiken blueprint apply -i contracts/plutus.json -m pool_mint -v pool_mint <SEED_PARAM>`
 *   `aiken blueprint convert … --to cardano-cli | cardano-cli latest transaction policyid`
 * and is pinned below. `buildCreatePool` must reproduce it through MeshJS's pure
 * `applyParamsToScript` + `resolveScriptHash`. (NB: `mint_test.ak`'s `policy = #"44…4e"`
 * is a placeholder, NOT a real applied hash, so it can't be used for this cross-check.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreatePool, type CreatePoolIntent } from "./createPool.ts";
import {
  decodePoolDatum,
  mintCloseRedeemer,
  mintCreateRedeemer,
  toCbor,
} from "./datums.ts";
import {
  LP_NAME_HEX,
  NFT_NAME_HEX,
  POOL_ADDR,
  POOL_MIN_ADA,
  TOTAL_LP,
} from "./deployment.ts";

// asset_a = TEST (same value as mint_test.ak's asset_a), asset_b = ADA.
const TOK_UNIT = "3333333333333333333333333333333333333333333333333333333d" + "54";
const PKH = "c0".repeat(28); // mint_test.ak's creator_vkh
const SEED = { txHash: "77".repeat(32), index: 3 }; // mint_test.ak's seed()

// Ground truth from `aiken blueprint apply` + `cardano-cli policyid` for SEED.
const GROUND_TRUTH_POLICY_ID =
  "68cd7477559b5702f95ca15722069fe0795445de197359acfd0c408d";

const base: CreatePoolIntent = {
  seed: SEED,
  ownerPkh: PKH,
  assetAUnit: TOK_UNIT,
  assetBUnit: "lovelace",
  feeNum: 3n,
  feeDen: 1000n,
};

test("policy id matches the contract toolchain (aiken apply + cardano-cli policyid)", () => {
  const built = buildCreatePool(base);
  assert.equal(built.policyId, GROUND_TRUTH_POLICY_ID);
  // identity: NFT/LP units are the policy id + the canonical names.
  assert.equal(built.nftUnit, GROUND_TRUTH_POLICY_ID + NFT_NAME_HEX);
  assert.equal(built.lpUnit, GROUND_TRUTH_POLICY_ID + LP_NAME_HEX);
});

test("create_ok: datum mirrors mint_test.ak (nft=policy/NFT, TEST/ADA pair, fee 3/1000, VK creator)", () => {
  const built = buildCreatePool(base);
  assert.equal(built.address, POOL_ADDR);

  const d = decodePoolDatum(toCbor(built.datum));
  // identity binding the validator checks: nft.policy == policyId, nft.name == nft_name.
  assert.deepEqual(d.nft, { policy: built.policyId, name: NFT_NAME_HEX });
  assert.deepEqual(d.assetA, {
    policy: "3333333333333333333333333333333333333333333333333333333d",
    name: "54",
  });
  assert.deepEqual(d.assetB, { policy: "", name: "" }); // ADA
  assert.equal(d.feeNum, 3n);
  assert.equal(d.feeDen, 1000n);
  assert.deepEqual(d.creator, { kind: "key", hash: PKH });
});

test("create_ok: value is an EMPTY pool — pool_min_ada + 1 NFT + total_lp LP, nothing else", () => {
  const built = buildCreatePool(base);
  assert.deepEqual(built.poolValue, [
    { unit: "lovelace", quantity: POOL_MIN_ADA.toString() },
    { unit: built.nftUnit, quantity: "1" },
    { unit: built.lpUnit, quantity: TOTAL_LP.toString() },
  ]);
});

test("applyParamsToScript is deterministic — same seed → same policy id, different seed → different id", () => {
  const a = buildCreatePool(base);
  const b = buildCreatePool({ ...base, seed: { ...SEED } });
  assert.equal(a.policyId, b.policyId);

  const c = buildCreatePool({ ...base, seed: { txHash: SEED.txHash, index: 4 } });
  assert.notEqual(c.policyId, a.policyId);

  const e = buildCreatePool({ ...base, seed: { txHash: "11".repeat(32), index: 3 } });
  assert.notEqual(e.policyId, a.policyId);
});

test("PoolDatum encode/decode round-trips byte-for-byte", () => {
  const cbor1 = toCbor(buildCreatePool(base).datum);
  const cbor2 = toCbor(buildCreatePool(base).datum);
  assert.equal(cbor1, cbor2);
  // and decodes back to the same structured datum
  assert.deepEqual(decodePoolDatum(cbor1), buildCreatePool(base).poolDatum);
});

test("mint redeemers: Create = Constr 0 [] (d87980), Close = Constr 1 [] (d87a80)", () => {
  assert.equal(toCbor(mintCreateRedeemer), "d87980");
  assert.equal(toCbor(mintCloseRedeemer), "d87a80");
});

test("malformed intents are rejected (never silently minted)", () => {
  // degenerate pair (raw-equal, and normalized-equal: distinct strings, same AssetId)
  assert.throws(() => buildCreatePool({ ...base, assetBUnit: TOK_UNIT }));
  assert.throws(() =>
    buildCreatePool({ ...base, assetAUnit: "lovelace", assetBUnit: "" }),
  );
  assert.throws(() =>
    buildCreatePool({ ...base, assetAUnit: TOK_UNIT, assetBUnit: TOK_UNIT.toUpperCase() }),
  );
  // fee out of range
  assert.throws(() => buildCreatePool({ ...base, feeDen: 0n }));
  assert.throws(() => buildCreatePool({ ...base, feeNum: -1n }));
  assert.throws(() => buildCreatePool({ ...base, feeNum: 1000n, feeDen: 1000n }));
  assert.throws(() => buildCreatePool({ ...base, feeNum: 1001n, feeDen: 1000n }));
  // non-VK / malformed creator
  assert.throws(() => buildCreatePool({ ...base, ownerPkh: "tooshort" }));
  assert.throws(() => buildCreatePool({ ...base, ownerPkh: "zz".repeat(28) }));
  // malformed asset unit (non-hex, and odd-length hex — would encode as raw text)
  assert.throws(() => buildCreatePool({ ...base, assetAUnit: "nothex" }));
  assert.throws(() => buildCreatePool({ ...base, assetAUnit: "ab".repeat(28) + "5" }));
  // an asset under the pool's OWN policy (would let reserve_of read NFT/LP as reserves)
  assert.throws(() =>
    buildCreatePool({ ...base, assetAUnit: GROUND_TRUTH_POLICY_ID + "abcd" }),
  );
});
