/**
 * Build a ShaSwap pool-creation mint from a user intent: the per-pool one-shot minting
 * policy (parameterised by a seed `OutputReference`), the `{NFT:1, LP:total_lp}` mint,
 * the inline `PoolDatum`, and the single pool output value. Pure and side-effect-free —
 * the wallet/tx wiring lives in `lib/client/tx.ts`; this is the script parameterisation
 * + encoding + value layout + strict validation, so it is unit-testable and a malformed
 * create is *rejected here*, never silently minted.
 *
 * Mirrors `mint.create` (contracts/lib/shaswap/mint.ak — the on-chain spec):
 *  - the seed `OutputReference` is consumed in the tx (makes the policy one-shot);
 *  - exactly `{NFT:1, LP:total_lp}` are minted under the per-seed `policyId` (nothing else);
 *  - both land together in ONE pool output with a well-formed inline `PoolDatum`
 *    (`nft.policy == policyId`, `nft.name == nft_name`);
 *  - `asset_a != asset_b`, and NEITHER asset is under `policyId`;
 *  - fee `0 <= fee_num < fee_den`, `fee_den > 0`; `creator` is a `VerificationKey`.
 *
 * Pool creation is permissionless (anyone may create a pool — a hyperstructure
 * requirement). Each pool has its OWN seed-parameterised policy, so its NFT/LP policy id
 * is unique; the pool VALIDATOR is shared (parameterised by the settlement tag `S`), so
 * all pools sit at the same `POOL_ADDR`. `applyParamsToScript`/`resolveScriptHash` are
 * pure (no provider), so this stays clear of the data-access seam.
 *
 * This builds an EMPTY pool (reserves = 0 ⇒ circulating LP = 0): value is just
 * `pool_min_ada` + the NFT + the full LP supply. The creator adds the first liquidity
 * afterward via the existing deposit flow (`/pools/[id]`, the `circ == 0` branch) — a
 * separate tx (the just-created pool can't be spent in the same tx). Keeping it empty
 * avoids the first-depositor donation quirk (pre-seeded reserves would be claimable by
 * whoever deposits first).
 */

import type { Asset, Data } from "@meshsdk/core";
import { applyParamsToScript, resolveScriptHash } from "@meshsdk/core";
import {
  assetFromUnit,
  type Credential,
  encodeOutputReference,
  encodePoolDatum,
  type OutputReference,
  type PoolDatum,
} from "./datums.ts";
import {
  LP_NAME_HEX,
  MAX_POOL_FEE_DEN,
  MAX_POOL_FEE_NUM,
  MAX_POOL_FEE_PCT,
  NFT_NAME_HEX,
  POOL_ADDR,
  POOL_MIN_ADA,
  POOL_MINT_COMPILED_CODE,
  TOTAL_LP,
} from "./deployment.ts";

const HEX28 = /^[0-9a-fA-F]{56}$/;

/** The connected wallet's create-pool intent. */
export interface CreatePoolIntent {
  /**
   * A wallet UTXO consumed as the one-shot seed. Parameterising `pool_mint` by this
   * `OutputReference` makes the minting policy unique per pool and un-repeatable (the
   * seed can only be spent once).
   */
  seed: OutputReference;
  /** Creator = the wallet's payment key hash (28-byte hex). MUST be a vkey (§I-03). */
  ownerPkh: string;
  /** The two distinct external assets, by unit ("lovelace" or `policy+name`). */
  assetAUnit: string;
  assetBUnit: string;
  /** Static fee `phi = feeNum/feeDen`, with `feeDen > 0` and `0 <= feeNum < feeDen`. */
  feeNum: bigint;
  feeDen: bigint;
}

export interface BuiltCreatePool {
  /** The per-pool one-shot policy id = hash of the seed-applied `pool_mint` script. */
  policyId: string;
  /** The parameterised V3 minting script (CBOR hex) to inline as the minting policy. */
  script: string;
  /** The inline `PoolDatum` as Mesh `Data` (default "Mesh" type). */
  datum: Data;
  /** The single pool output value: `pool_min_ada` + 1 NFT + `total_lp` LP (EMPTY pool). */
  poolValue: Asset[];
  /** Where the pool lives — the shared, `S`-tagged pool address. */
  address: string;
  /** The pool NFT unit (`policyId + nft_name`) — the pool's id in the UI. */
  nftUnit: string;
  /** The pool LP unit (`policyId + lp_name`). */
  lpUnit: string;
  /** The structured datum (handy for display / tests). */
  poolDatum: PoolDatum;
}

/** Validate + build a pool-creation mint. Throws on any malformed intent (never mints garbage). */
export function buildCreatePool(intent: CreatePoolIntent): BuiltCreatePool {
  const { seed, ownerPkh, assetAUnit, assetBUnit, feeNum, feeDen } = intent;

  if (!HEX28.test(ownerPkh)) {
    throw new Error("pool creator must be a 28-byte payment key hash (vkey)");
  }
  if (feeDen <= 0n) throw new Error("fee denominator must be positive");
  if (feeNum < 0n) throw new Error("fee numerator must be non-negative");
  if (feeNum >= feeDen) throw new Error("fee must be below 1 (feeNum < feeDen)");
  // "static, LOW fees" (§3) is enforced HERE, app-side: the validators only bound φ < 1,
  // so without this guard the official frontend could mint an immutable, permanently-
  // discoverable trap pool with a predatory/typo fee. Reject φ > MAX_POOL_FEE (integer
  // cross-multiply, no floats). See documentation/spec/economic-parameters.md.
  if (feeNum * MAX_POOL_FEE_DEN > MAX_POOL_FEE_NUM * feeDen) {
    throw new Error(`pool fee must be at most ${MAX_POOL_FEE_PCT}% (φ ≤ 1/20)`);
  }

  // `assetFromUnit` throws on a malformed unit (bad hex / odd length / too short).
  const assetA = assetFromUnit(assetAUnit);
  const assetB = assetFromUnit(assetBUnit);

  // Compare NORMALIZED AssetIds, not raw unit strings: "lovelace" vs "" and upper- vs
  // lower-case hex are distinct strings that map to the SAME asset. `mint.create` rejects
  // `asset_a == asset_b`, so reject it here too rather than build a pool the node refuses.
  if (assetA.policy === assetB.policy && assetA.name === assetB.name) {
    throw new Error("pool pair assets must differ");
  }

  // The per-pool one-shot policy: apply the seed `OutputReference`, then hash. Verified
  // byte-for-byte equal to `aiken blueprint apply` + `cardano-cli policyid` for a fixed
  // seed (see `createPool.test.ts`).
  const script = applyParamsToScript(
    POOL_MINT_COMPILED_CODE,
    [encodeOutputReference(seed)],
    "Mesh",
  );
  const policyId = resolveScriptHash(script, "V3");

  // Neither side of the pair may live under the pool's own policy — else `reserve_of`
  // would read the pool's own NFT/LP as reserves (`mint.create` rejects this).
  if (assetA.policy === policyId || assetB.policy === policyId) {
    throw new Error("pool assets must not be under the pool's own mint policy");
  }

  const nftUnit = policyId + NFT_NAME_HEX;
  const lpUnit = policyId + LP_NAME_HEX;

  const creator: Credential = { kind: "key", hash: ownerPkh.toLowerCase() };
  const poolDatum: PoolDatum = {
    nft: { policy: policyId, name: NFT_NAME_HEX },
    assetA,
    assetB,
    feeNum,
    feeDen,
    creator,
  };

  // EMPTY pool: min-ADA + the NFT + the full LP supply, ALL in this ONE output (none to
  // change). No reserves — the creator seeds them via the deposit flow next.
  const poolValue: Asset[] = [
    { unit: "lovelace", quantity: POOL_MIN_ADA.toString() },
    { unit: nftUnit, quantity: "1" },
    { unit: lpUnit, quantity: TOTAL_LP.toString() },
  ];

  return {
    policyId,
    script,
    datum: encodePoolDatum(poolDatum),
    poolValue,
    address: POOL_ADDR,
    nftUnit,
    lpUnit,
    poolDatum,
  };
}
