/**
 * Public, committed preprod deployment identities for the ShaSwap contracts.
 *
 * Source of truth: `contracts/happy_path/deployment.json` (+ `constants.ak`). These
 * are all derived/public values — script hashes, the settlement stake tag `S`, pool
 * mint info, reference-script UTXOs, on-chain constants. There are NO secrets here
 * (the Blockfrost project id is a server-only env var; see `getDataProvider()`).
 *
 * The app is deliberately decoupled from `contracts/` — we mirror the values rather
 * than read that file. If the deployment changes, update this file (and the
 * `address.test.ts` pin will catch a hash/address mismatch).
 *
 * Trust-anchor wiring (BLUEPRINT §5.4, Rev 6): order/pool UTXOs are tagged with the
 * settlement staking credential `S` as their stake credential. So the order/pool
 * addresses are *base* addresses = (payment = order/pool script hash, stake =
 * `S` script hash). See `ORDER_ADDR` / `POOL_ADDR`.
 */

import type { Network, NetworkId } from "@/lib/config";

/** This deployment targets preprod. The whole app's network is one config value. */
export const DEPLOYMENT_NETWORK: Network = "preprod";
export const DEPLOYMENT_NETWORK_ID: NetworkId = 0;

/** Settlement validator hash — also the stake-credential tag `S` (§5.4). */
export const SETTLEMENT_HASH =
  "a57de7a9191ab5544173287119f7203724c2d7a7b0457d367545211e";
/** Order validator hash (payment credential of the order address). */
export const ORDER_SCRIPT_HASH =
  "801c7a4c4268b986d0dfd90010ee5d5708c18b19be485b53e88d22f2";
/** Pool validator hash (payment credential of the pool address). */
export const POOL_SCRIPT_HASH =
  "4427ef8453f1acb4fac3844fbc7c34852fe188e4ab99f3fda07b533b";

/**
 * First pool's one-shot mint policy. NOTE: each pool has its OWN seed-parameterised
 * mint policy, so this is NOT a global filter — pools are identified generically by
 * "the UTXO holds the NFT its own `PoolDatum` declares" (see the Blockfrost provider,
 * mirroring the batcher's `find_pools`). Kept for reference/diagnostics only.
 */
export const FIRST_POOL_MINT_POLICY =
  "3d36f7963dcca05ba53e32babdf3c2572d467c7388dbb1cf4b28645f";

/** `constants.nft_name` = "NFT" (the pool NFT asset name, shared across pools). */
export const NFT_NAME_HEX = "4e4654";
/** `constants.lp_name` = "LP" (the pool LP asset name, shared across pools). */
export const LP_NAME_HEX = "4c50";

/** `constants.pool_min_ada` — min-ADA carved out of an ADA pool reserve (§5.2.1). */
export const POOL_MIN_ADA = 2_000_000n;
/** `constants.order_min_ada` — per-UTXO min-ADA for an order/remainder output. */
export const ORDER_MIN_ADA = 2_000_000n;

/**
 * `constants.total_lp` — the full LP supply, minted into the pool UTXO at creation
 * (i64::MAX). Circulating supply = `total_lp − (LP held in the pool UTXO)`; no counter
 * is stored on-chain. The LP share math is derived from this and the held balance.
 */
export const TOTAL_LP = 9_223_372_036_854_775_807n;
/**
 * `constants.min_liq` — permanently-locked minimum liquidity (Uniswap-v2 style). The
 * first deposit sends `min_liq` LP to `Script(nft.policy)`; circulating LP can never
 * fall below it thereafter.
 */
export const MIN_LIQ = 1_000n;

/**
 * On-chain reference scripts (all deployed in one tx; `contracts/happy_path`). The
 * app needs the ORDER ref script — to spend an order on the `Reclaim` path without
 * inlining the validator — and the POOL ref script — to spend the pool UTXO on the
 * standalone `LpAction` (deposit/withdraw) path (§6). The settlement ref is the
 * solver's concern. Indices match `contracts/happy_path/deployment.json`
 * (`order_ref` = #2, `pool_ref` = #1 of the same deploy tx).
 */
export const ORDER_REF = {
  txHash: "78130a6c6f88173ac3b6c75babb10de03f68b239213e95f4a83d5959fec8fc7e",
  outputIndex: 2,
} as const;

export const POOL_REF = {
  txHash: "78130a6c6f88173ac3b6c75babb10de03f68b239213e95f4a83d5959fec8fc7e",
  outputIndex: 1,
} as const;

/**
 * Byte size of the deployed order validator (the `cborHex` of
 * `contracts/happy_path/scripts/order.plutus` is 1074 hex chars = 537 bytes). Passed
 * to `spendingTxInReference` so the client can compute the Conway reference-script fee
 * without an extra round-trip to resolve the ref UTXO.
 */
export const ORDER_SCRIPT_SIZE = 537;

/**
 * Byte size of the deployed pool validator (the `cborHex` of
 * `contracts/happy_path/scripts/pool.plutus` is 4472 hex chars = 2236 bytes). Same
 * role as `ORDER_SCRIPT_SIZE` for the `LpAction` spend.
 */
export const POOL_SCRIPT_SIZE = 2236;

/**
 * Where orders live: a base address tagged with `S`.
 *   payment credential = ORDER_SCRIPT_HASH (script), stake credential = `S` (script).
 * Posting an order = a plain payment to this address with an inline `OrderDatum`; the
 * stake tag rides along in the bech32 so the UTXO is automatically delegated to `S`.
 *
 * Pinned to the derivation `deriveBaseAddress(ORDER_SCRIPT_HASH, SETTLEMENT_HASH, 0)`
 * by `address.test.ts` — a hash/address drift fails that test.
 */
export const ORDER_ADDR =
  "addr_test1xzqpc7jvgf5tnpksmlvsqy8wt4ts3svtrxlysk6nazxj9u490hn6jxg6k42yzuegwyvlwgphynpd0fasg47nva29yy0q4qj5a7";

/** Where the pool lives: base address (payment = POOL_SCRIPT_HASH, stake = `S`). */
export const POOL_ADDR =
  "addr_test1xpzz0muy20c6ed86cwzyl0ruxjzjlcvguj4enula5pa4xwa90hn6jxg6k42yzuegwyvlwgphynpd0fasg47nva29yy0qvte56r";

/**
 * The LP-token unit for a pool, given its NFT unit. LP and the NFT share the pool's
 * one-shot mint policy (`nft.policy`); only the asset name differs (`4e4654` "NFT" vs
 * `4c50` "LP"). So `lpUnit = poolNftPolicy + LP_NAME_HEX`. Pool ids in the UI are the
 * NFT unit (`policy(56) + nftName`), so we take the policy off the front.
 */
export function lpUnitForPool(poolNftUnit: string): string {
  if (poolNftUnit.length < 56 || !/^[0-9a-fA-F]+$/.test(poolNftUnit)) {
    throw new Error(`malformed pool NFT unit: ${poolNftUnit}`);
  }
  return poolNftUnit.slice(0, 56).toLowerCase() + LP_NAME_HEX;
}
