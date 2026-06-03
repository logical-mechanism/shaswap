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

/**
 * The UNapplied `pool_mint.pool_mint.mint` compiled code (from `contracts/plutus.json`)
 * — a committed public value, like the script hashes above. Pool creation is
 * permissionless and each pool has its OWN one-shot minting policy: apply the seed
 * `OutputReference` to this code (`applyParamsToScript`) then hash it (`resolveScriptHash`)
 * to get the pool's NFT/LP policy id. The UNapplied hash is
 * `9ff1ef1813e22fa5e21be2c52a340d06584b4724095f010fc3a5ccbc`; the real policy id is
 * per-seed (computed in `buildCreatePool`). Cross-checked byte-for-byte against
 * `aiken blueprint apply` + `cardano-cli policyid` for a fixed seed in `createPool.test.ts`.
 */
export const POOL_MINT_COMPILED_CODE =
  "59070d010100229800aba2aba1aba0aab9faab9eaab9dab9a488888896600264653001300800198041804800cdc3a400130080024888966002600460106ea800e266446644b300130060018acc004c034dd5004400a2c80722b300130030018acc004c034dd5004400a2c80722c805900b0cc0048c8cc004004008896600200314bd7044c8cc88cc88cc008008004896600200310038991980b1ba733016375200a6602c60260026602c602800297ae0330030033018002301600140506eacc04400cdd718070009980180198098011808800a01e912cc004006297ae089980798061808000998010011808800a01c91191919800800802112cc004006007132325980099b910060018acc004cdc7803000c4dd59809001401501044cc010010c05800d0101bae301000130130014044297adef6c60918079808180818081808000a44446464b3001300a3010375401919800912cc004c030c048dd500144c8c8cc896600260360070058b2030375c60300026eb8c060008c060004c04cdd500145901148966002003148002266e0120023300200230170014051222323322330020020012259800800c00e26464b30013372200c00315980099b8f00600189bad3019002802a02e899802002180e801a02e375c602e002603400280c0cc02001000c520009180a980b180b000c8c054c0580064602a602c602c602c0029111112cc004c8cc004004dd6180d980c1baa0102259800800c528456600266ebcc070c064dd5180e00080fc528c4cc008008c07400501720348acc004cdc3a40086600a00a60186600e6eacc024c05cdd50079980c9ba900e4bd704566002601b300137566012602e6ea803e01d489034e465400401115980099b87483fbfffffffffffffffc0660026eacc024c05cdd5007c03a9101024c50004011132598009808980b9baa0018992cc004cdc3a400860306ea800626464b30013014301a3754005132323232323298009812000cc0900166048009375a6048007375a6048004911112cc004c0a801a26602a605201626602a00826602a006264b30013020001899192cc004c0b400a01f1640a86eb8c0ac004c09cdd50034566002603a00313232598009816801403e2c8150dd7181580098139baa0068b204a4094604a6ea80162c81386048002604600260440026042002604000260366ea800a2c80c856600266e3cdd7180e980d1baa301d301a375400202315980099b8f4881034e465400375c600a60346ea8c074c068dd5000c56600330013375e600a60346ea8004c018c068dd5000d28528a0308acc006600266e3cdd7180e980d1baa3005301a37540020234a14a280c22b3001980099b8f375c603a60346ea8c018c068dd5000808d28528a0308acc004cdc4240006eb4c030c068dd5000c56600266e252000375a600860346ea80062b3001337106eb4c010c068dd50009bad300c301a37540031598009809980c9baa301d301e301e301e301e301e301a375400314a3164061164061164061164061164061164061164061164061164060603860326ea80062c80b8c010c060dd5180d980c1baa0018b202c32330010013758600860306ea8040896600200314c103d87a80008992cc00566002602130013756600a60346ea80060234881034e465400401d13370e907f7fffffffffffffff80cc004dd59802980d1baa001808d221024c5000401d14a080c2266e9520003301c0014bd7044cc00c00cc078009018180e000a0348b202a8b202a8b202a8b202a44c8cc004004c01ccc008dd5980218091baa00a33014375201297ae02259800800c528c56600266e24dd6980b180b980b9bac301600148002266004004602e00314a08089014201e22323300100130040032259800800c52f5bded8c113322598009919800800803112cc00400629422b30013371e6eb8c06c0040122946266004004603800280b101944c8cc004004cc02801c00c896600200310038994c004dd7180c000cdd6980c800ccc00c00cc07400922259800980a80144006264646600200200644b300100189981099bb037520166e9800d2f5bded8c113233225980099b9100e0028acc004cdc780700144c96600266ebd300101a000374c003100289981299bb0375201e6e9800400902119198008009bab30230042259800800c4cc098cdd81ba900b375001497adef6c6089919912cc004cdc8807001456600266e3c03800a264b30013370e00266e05200000e880144cc0a8cdd81ba900f375066e000040380090261bad302700389981499bb0375201c6ea003401102544cc0a400ccc0140140050251bae3024001302900230270014095133024337606ea4038dd3003002204089981200199802802800a040375c603e002604800460440028100cc078cdd81ba9003375000497adef6c604068301b0014065100140506eb8c05c004cc008008c06000501518018018c028dd50031bae300c300937540066e1d20028b200e180400098019baa0088a4d13656400401";
