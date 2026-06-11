/**
 * Public, committed per-network deployment identities for the ShaSwap contracts.
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

// Relative `.ts` import (not the `@/` alias) so the node test runner
// (`--experimental-strip-types`) can resolve it — several tests load this module.
// NOTE: kept free of any `@meshsdk/core-cst` runtime import on purpose — the order/pool
// addresses are committed LITERALS (pinned to the canonical derivation by `address.test.ts`)
// rather than derived here, so this stays pure data and loads in every test environment
// (the jsdom vitest suite imports it via `fixtures.ts`, and core-cst's bech32 encoder
// throws under jsdom's cross-realm Uint8Array).
import { APP_CONFIG, type Network, type NetworkId } from "../config.ts";

/**
 * Per-network deployment identities. The whole app's network is one config value
 * (`APP_CONFIG.network`, from `NEXT_PUBLIC_NETWORK`); this table maps it to the
 * network-DEPENDENT values. Most network-INDEPENDENT values below (settlement/order/
 * lp_intent hashes, compiled code, asset names, on-chain constants) are the SAME on every
 * network — a Plutus script hash is the hash of its compiled code, not network-tagged — so
 * they are plain shared exports. The ONE exception is the `pool` hash: the H-01 partial fork
 * (Rev 29) lands on preprod before mainnet, so `poolScriptHash` is carried PER-NETWORK in this
 * table (preprod forked, mainnet on Rev 25 until its own fork). Order/pool ADDRESSES are
 * committed per-network LITERALS (see `ORDER_ADDR`/`POOL_ADDR`), each pinned to the canonical
 * hash-based derivation by `address.test.ts`.
 *
 * Only the reference-script UTXOs are genuinely per-network. `deployed` gates the
 * tx-building paths: a network whose reference scripts aren't live (preview) can still be
 * READ — addresses resolve, pool/order scans just come back empty — but cannot build spends
 * (see `requireDeployed`).
 */
type RefScript = { txHash: string; outputIndex: number };

interface NetworkDeployment {
  networkId: NetworkId;
  /** Are ShaSwap's reference scripts deployed and live on this network? */
  deployed: boolean;
  /**
   * Order address = base(payment = ORDER_SCRIPT_HASH, stake = `S`) for this network.
   * A committed literal pinned to `deriveBaseAddress(...)` by `address.test.ts`. Testnets
   * (preprod/preview) share one `addr_test1…` (the bech32 only tags testnet vs mainnet);
   * mainnet is `addr1…`.
   */
  orderAddr: string;
  /** Pool address = base(payment = `poolScriptHash`, stake = `S`). Same rules as `orderAddr`. */
  poolAddr: string;
  /**
   * Pool validator hash (payment credential of the pool address) for THIS network. PER-NETWORK
   * during the H-01 partial fork (Rev 29): preprod runs the fixed pool `757ba6b7…`, mainnet is
   * still on the Rev 25 pool `34b30c7a…` until its own fork. Every OTHER script hash
   * (settlement `S`, order, lp_intent) stays network-independent (shared export), since only
   * the `pool` validator changed.
   */
  poolScriptHash: string;
  /**
   * Byte size of THIS network's pool reference script (cborHex length / 2), for the Conway
   * ref-script fee in `spendingTxInReference`. PER-NETWORK during the H-01 fork: the fixed
   * pool is larger (3028 B) than the Rev 25 pool (2928 B). A stale/too-small value
   * underprices the fee and the node rejects the spend at submit (`FeeTooSmallUTxO`).
   */
  poolScriptSize: number;
  /** Order reference-script UTXO — `null` until this network is deployed. */
  orderRef: RefScript | null;
  /** Pool reference-script UTXO — `null` until this network is deployed. */
  poolRef: RefScript | null;
  /**
   * `lp_intent` reference-script UTXO — `null` on a network where the LP-intent path isn't
   * live. The `lp_intent` validator is part of the post-audit (Rev 22+) deployment set and is
   * live on preprod and mainnet; where this is `null` (preview), posting/reclaiming an intent
   * throws via `requireLpIntentDeployed()` (a `null` here also means `LP_INTENTS_LIVE === false`).
   * Reads still resolve the address (and just come back empty). The `lp_intent` script HASH and its
   * enterprise address are DERIVED (not literals) from `SETTLEMENT_HASH` — see
   * `lpIntentScript.ts` — so they auto-track whatever `S` this deployment declares.
   */
  lpIntentRef: RefScript | null;
}

// Testnet order/pool addresses (preprod AND preview — identical, since a Cardano address
// only tags testnet vs mainnet, not which testnet).
const TESTNET_ORDER_ADDR =
  "addr_test1xrnl5x3ctgzvzqlvue6xhs2m3ecumuwvk6z5m0f4yna3frdrqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qlzjxy5";
// Preprod pool address — forked to the H-01 pool (Rev 29). Mainnet keeps its own (below).
const TESTNET_POOL_ADDR =
  "addr_test1xp6hhf4h8y3texyzgesm7n0tjrn2qcgyzuzuqv4vua26l5arqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qvt5def";

/**
 * Pool validator hash — PER-NETWORK during the H-01 partial fork (Rev 29). Preprod runs the
 * fixed pool (`pool_settle` S-tag self-check + held-LP pin); mainnet stays on the Rev 25 pool
 * until its own fork. Exported so `address.test.ts` can pin each network's hash→address
 * derivation independently. Every other script hash stays network-independent.
 */
export const PREPROD_POOL_SCRIPT_HASH =
  "757ba6b73922bc98824661bf4deb90e6a061041705c032ace755afd3";
export const MAINNET_POOL_SCRIPT_HASH =
  "34b30c7a2d34c8185838544f5746afcc69056fa1ef15b0a5cf97e4ac";

/**
 * Per-network deployment identities, selected by `APP_CONFIG.network`. Reference-script
 * UTXO indices match `contracts/happy_path/deployment.json` (`order_ref` = #2,
 * `pool_ref` = #1 of the same deploy tx). To turn ShaSwap on for a network: deploy the
 * reference scripts there, paste the deploy tx hash + indices here, and flip `deployed`.
 */
const DEPLOYMENTS: Record<Network, NetworkDeployment> = {
  preprod: {
    networkId: 0,
    deployed: true,
    orderAddr: TESTNET_ORDER_ADDR,
    poolAddr: TESTNET_POOL_ADDR,
    poolScriptHash: PREPROD_POOL_SCRIPT_HASH,
    poolScriptSize: 3028,
    orderRef: {
      txHash: "9088f8dc39a97a547b184054c50254b1069c73dedca2f6985357db84750a29e5",
      outputIndex: 2,
    },
    // H-01 partial fork (Rev 29): the new pool reference script (only the pool hash changed;
    // settlement/order/lp_intent refs stay at the Rev 25 deploy tx 9088f8dc).
    poolRef: {
      txHash: "6bd62b207786741f623348d1d3e1be40ac141d96b134deb4f4b8af678dba5bdc",
      outputIndex: 0,
    },
    // Post-audit redeploy (Rev 24): the lp_intent reference script is live (#3 of the same
    // deploy tx), so the batcher LP-intent path is ON (LP_INTENTS_LIVE true on preprod).
    lpIntentRef: {
      txHash: "9088f8dc39a97a547b184054c50254b1069c73dedca2f6985357db84750a29e5",
      outputIndex: 3,
    },
  },
  // Contracts are not deployed on preview (addresses are the same as preprod's).
  preview: {
    networkId: 0,
    deployed: false,
    orderAddr: TESTNET_ORDER_ADDR,
    poolAddr: TESTNET_POOL_ADDR,
    poolScriptHash: PREPROD_POOL_SCRIPT_HASH,
    poolScriptSize: 3028,
    orderRef: null,
    poolRef: null,
    lpIntentRef: null,
  },
  // Mainnet deploy 2026-06-08, tx d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb
  // (settlement #0, pool #1, order #2, lp_intent #3). Each ref's on-chain script hash was
  // re-hashed against the audited Rev 25 hashes (via Koios) before wiring; `deployed: true`
  // turns the tx-building paths on, and a non-null `lpIntentRef` flips `LP_INTENTS_LIVE` true.
  mainnet: {
    networkId: 1,
    deployed: true,
    orderAddr:
      "addr1x8nl5x3ctgzvzqlvue6xhs2m3ecumuwvk6z5m0f4yna3frdrqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qu50xgt",
    poolAddr:
      "addr1xy6txrr6956vsxzc8p2y746x4lxxjpt058h3tv99e7t7ft9rqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qlzsnyq",
    // Mainnet still on the Rev 25 pool until its own H-01 fork (frontend in maintenance).
    poolScriptHash: MAINNET_POOL_SCRIPT_HASH,
    poolScriptSize: 2928,
    orderRef: {
      txHash: "d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb",
      outputIndex: 2,
    },
    poolRef: {
      txHash: "d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb",
      outputIndex: 1,
    },
    lpIntentRef: {
      txHash: "d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb",
      outputIndex: 3,
    },
  },
};

/** The active network's deployment, selected by the one app-wide network knob. */
const ACTIVE: NetworkDeployment = DEPLOYMENTS[APP_CONFIG.network];

/** Active network — bound to `APP_CONFIG` so deployment and UI can never drift. */
export const DEPLOYMENT_NETWORK: Network = APP_CONFIG.network;
export const DEPLOYMENT_NETWORK_ID: NetworkId = ACTIVE.networkId;
/** Whether ShaSwap's contracts are live on the active network (gates tx-building). */
export const DEPLOYED: boolean = ACTIVE.deployed;

/** Settlement validator hash — also the stake-credential tag `S` (§5.4). Post-audit set (Rev 24). */
export const SETTLEMENT_HASH =
  "a305a3cfd8343c03abffa0ef2b3ab6c756557a0dc5fb298c747259ea";
/** Order validator hash (payment credential of the order address). */
export const ORDER_SCRIPT_HASH =
  "e7fa1a385a04c103ece6746bc15b8e71cdf1ccb6854dbd3524fb148d";
/**
 * Pool validator hash (payment credential of the pool address) for the ACTIVE network.
 * PER-NETWORK during the H-01 partial fork (Rev 29) — preprod `757ba6b7…`, mainnet
 * `34b30c7a…` — see `poolScriptHash` in the `DEPLOYMENTS` table. (Unlike `SETTLEMENT_HASH`
 * and `ORDER_SCRIPT_HASH`, which stay network-independent since only `pool` changed.)
 */
export const POOL_SCRIPT_HASH = ACTIVE.poolScriptHash;

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

// ── App-side policy guards (NOT on-chain) ───────────────────────────────────────────
// These enforce the "static, LOW fees" §3 invariant and tip sanity in the OFFICIAL
// frontend. The validators only bound `0 ≤ φ < 1` and impose no tip floor (pool creation
// is permissionless and the contracts are immutable), so a predatory/typo fee or a
// stranded low-tip order is prevented HERE rather than on-chain. See
// documentation/spec/economic-parameters.md.

/**
 * Maximum pool fee the dApp will create: `φ = MAX_POOL_FEE_NUM / MAX_POOL_FEE_DEN` = 5%.
 * Generous headroom over typical AMM fees (0.05–1%) while blocking trap pools (e.g. 99%)
 * that would be permanent on immutable, permissionlessly-discoverable pools.
 */
export const MAX_POOL_FEE_NUM = 1n;
export const MAX_POOL_FEE_DEN = 20n;
/** Human label for the cap (kept in sync with the rational above). */
export const MAX_POOL_FEE_PCT = 5;

/** A pool fee at/above this (basis points) is flagged "high" in the trade UI. 1% = 100 bps. */
export const HIGH_FEE_BPS = 100;

/**
 * Recommended minimum solver tip (lovelace) = the solo-batch floor. A single-order
 * settlement pays the whole tx fee (~0.2–0.5 ADA), so 0.5 ₳ keeps an order self-funding
 * even in the worst case where it never batches with others — and if it DOES batch, the
 * tip simply over-covers its share. Below this the swap/LP UI cautions the order may be
 * skipped (an untrusted solver won't settle a tip that can't cover its fee). It's also the
 * default swap tip. `buildOrder` still only HARD-rejects a non-positive tip — this is
 * advisory, not enforced.
 */
export const RECOMMENDED_MIN_TIP = 500_000n;

/**
 * On-chain reference scripts for the ACTIVE network (see the `DEPLOYMENTS` table). The
 * app needs the ORDER ref script — to spend an order on the `Reclaim` path without
 * inlining the validator — and the POOL ref script — to spend the pool UTXO on the
 * standalone `LpAction` (deposit/withdraw) path (§6). The settlement ref is the solver's
 * concern. These are `null` on a network that isn't deployed yet; tx builders go through
 * `requireDeployed()` so a null never slips into a spend.
 */
export const ORDER_REF: RefScript | null = ACTIVE.orderRef;
export const POOL_REF: RefScript | null = ACTIVE.poolRef;

/**
 * `lp_intent` reference-script UTXO for the ACTIVE network — `null` on a network where the
 * LP-intent path isn't live (live on preprod and mainnet; absent on preview). Needed by the
 * `ReclaimLp` builder to spend an intent via the reference script (no inlined 2.8 kB
 * validator). `null` ⇒ LP intents are not live here.
 */
export const LP_INTENT_REF: RefScript | null = ACTIVE.lpIntentRef;

/**
 * Whether the batcher-fulfilled LP-intent path is LIVE on the active network. Gated on the
 * `lp_intent` reference script being deployed (live on preprod and mainnet; absent on
 * preview): where it isn't, a posted intent could be neither fulfilled (no batcher on this
 * set) nor reclaimed (no ref script) — a fund trap — so `requireLpIntentDeployed()` refuses to
 * build either tx. The UI reads this to keep the intent path visible-but-disabled and fall
 * back to the always-available Direct LP path.
 */
export const LP_INTENTS_LIVE: boolean = DEPLOYED && LP_INTENT_REF !== null;

/**
 * `lp_intent_types.lp_intent_min_ada` (= `order_min_ada`, 2 ADA) — the per-UTXO min-ADA an
 * LP intent and its owner payout assume. Not a validator-enforced floor (the validator pins
 * the payout value exactly and the ledger's own min-ADA rule rejects an under-funded payout);
 * the app funds it so a posted intent is always fulfillable. Defined here, mirroring the
 * non-frozen `lp_intent_types` module (NOT the frozen `constants.ak`).
 */
export const LP_INTENT_MIN_ADA = 2_000_000n;

/**
 * Byte size of the S-applied `lp_intent` validator (the `cborHex` of
 * `contracts/happy_path/scripts/lp_intent.plutus` is 5908 hex chars = 2954 bytes — re-hashed
 * for the Rev 25 at-ratio LP pin; see `lpIntentScript.ts`). Passed to `spendingTxInReference`
 * so the client can price the Conway reference-script fee on the `ReclaimLp` spend without
 * resolving the ref UTXO.
 */
export const LP_INTENT_SCRIPT_SIZE = 2954;

/**
 * Narrow the `lp_intent` reference script for a tx-building path, throwing a legible error on
 * a network where the LP-intent path isn't live (e.g. preview). Reads never call this — they
 * resolve the (empty) lp_intent address instead. Mirrors `requireDeployed()`.
 */
export function requireLpIntentDeployed(): { lpIntentRef: RefScript } {
  if (!LP_INTENTS_LIVE || !LP_INTENT_REF) {
    throw new Error(
      `Batcher-processed LP (deposit/withdraw intents) is not live on ${DEPLOYMENT_NETWORK}. ` +
        `Use the Direct (advanced) liquidity path for now.`,
    );
  }
  return { lpIntentRef: LP_INTENT_REF };
}

/**
 * Narrow the per-network reference scripts for a tx-building path. Throws a legible error
 * on a network where ShaSwap isn't live (e.g. preview) instead of crashing on a null
 * `txHash`. Reads never call this — they degrade to empty results.
 */
export function requireDeployed(): { orderRef: RefScript; poolRef: RefScript } {
  if (!DEPLOYED || !ORDER_REF || !POOL_REF) {
    throw new Error(
      `ShaSwap contracts are not live on ${DEPLOYMENT_NETWORK}. ` +
        `Posting orders and LP actions are disabled on this network.`,
    );
  }
  return { orderRef: ORDER_REF, poolRef: POOL_REF };
}

/**
 * Byte size of the deployed order validator (the `cborHex` of
 * `contracts/happy_path/scripts/order.plutus` is 1074 hex chars = 537 bytes). Passed
 * to `spendingTxInReference` so the client can compute the Conway reference-script fee
 * without an extra round-trip to resolve the ref UTXO.
 */
export const ORDER_SCRIPT_SIZE = 537;

/**
 * Byte size of the ACTIVE network's pool reference script (cborHex length / 2), passed to
 * `spendingTxInReference` for the Conway ref-script fee. PER-NETWORK during the H-01 fork:
 * preprod's fixed pool is 3028 B (`scripts/pool.plutus` cborHex = 6056), mainnet's Rev 25
 * pool is 2928 B — see `poolScriptSize` in `DEPLOYMENTS`. A stale/too-small value underprices
 * the fee and the node rejects the `LpAction` spend at submit (`FeeTooSmallUTxO`).
 */
export const POOL_SCRIPT_SIZE = ACTIVE.poolScriptSize;

/**
 * Where orders live: a base address tagged with `S`.
 *   payment credential = ORDER_SCRIPT_HASH (script), stake credential = `S` (script).
 * Posting an order = a plain payment to this address with an inline `OrderDatum`; the
 * stake tag rides along in the bech32 so the UTXO is automatically delegated to `S`.
 *
 * The active network's committed literal (see the `DEPLOYMENTS` table). Pinned to
 * `deriveBaseAddress(ORDER_SCRIPT_HASH, SETTLEMENT_HASH, networkId)` for BOTH networks by
 * `address.test.ts` — a hash/address drift fails that test.
 */
export const ORDER_ADDR: string = ACTIVE.orderAddr;

/** Where the pool lives: base address (payment = POOL_SCRIPT_HASH, stake = `S`). */
export const POOL_ADDR: string = ACTIVE.poolAddr;

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
 * `f558dfb2dcd5c40f5579cf6c660fc8987d87ab2a6e50e7076b789aa4`; the real policy id is
 * per-seed (computed in `buildCreatePool`). Cross-checked byte-for-byte against
 * `aiken blueprint apply` + `cardano-cli policyid` for a fixed seed in `createPool.test.ts`.
 */
export const POOL_MINT_COMPILED_CODE =
  "590731010100229800aba2aba1aba0aab9faab9eaab9dab9a488888896600264653001300800198041804800cdc3a400130080024888966002600460106ea800e266446644b300130060018acc004c034dd5004400a2c80722b300130030018acc004c034dd5004400a2c80722c805900b0cc0048c8cc004004008896600200314bd7044c8cc88cc88cc008008004896600200310038991980b1ba733016375200a6602c60260026602c602800297ae0330030033018002301600140506eacc04400cdd718070009980180198098011808800a01e912cc004006297ae089980798061808000998010011808800a01c91191919800800802112cc004006007132325980099b910060018acc004cdc7803000c4dd59809001401501044cc010010c05800d0101bae301000130130014044297adef6c60918079808180818081808000a44446464b3001300a3010375401919800912cc004c030c048dd500144c8c8cc896600260360070058b2030375c60300026eb8c060008c060004c04cdd500145901148966002003148002266e0120023300200230170014051222323322330020020012259800800c00e26464b30013372200c00315980099b8f00600189bad3019002802a02e899802002180e801a02e375c602e002603400280c0cc02001000c520009180a980b180b000c8c054c0580064602a602c602c602c0029111112cc004c8cc004004dd6180d980c1baa0102259800800c528456600266ebcc070c064dd5180e00080fc528c4cc008008c07400501720348acc004cdc3a40086600a00a60186600e6eacc024c05cdd50079980c9ba900e4bd704566002601b300137566012602e6ea803e01d489034e465400401115980099b87483fbfffffffffffffffc0660026eacc024c05cdd5007c03a9101024c50004011132598009808980b9baa001899192cc004cdc3a400860326ea800626464b30013015301b3754005132323232323298009812800cc094016604a009375a604a007375a604a004911112cc004c0ac01a26602c605401626602c00826602c006264b30013021001899192cc004c0b800a01f1640ac6eb8c0b0004c0a0dd50034566002603c00313232598009817001403e2c8158dd7181600098141baa0068b204c4098604c6ea80162c8140604a002604800260460026044002604200260386ea800a2c80d056600266e3cdd7180f180d9baa301e301b375400202515980099b8f4881034e465400375c600c60366ea8c078c06cdd5000c56600330013375e600c60366ea8004c01cc06cdd5000d28528a0328acc006600266e3cdd7180f180d9baa3006301b37540020254a14a280ca2b3001980099b8f375c603c60366ea8c01cc06cdd5000809528528a0328acc004cdc4240006eb4c034c06cdd5000c56600266e252000375a600a60366ea80062b3001337106eb4c014c06cdd50009bad300d301b3754003159800980a180d1baa301e301f301f301f301f301f301b375400315980099b89482024bd00660026eacc018c06cdd5001d22100a44100402114a3164065164065164065164065164065164065164065164065164065164064603a60346ea80062c80c0c014c064dd5000980d980c1baa0018b202c32330010013758600860306ea8040896600200314c0103d87a80008992cc00566002602130013756600a60346ea80060234881034e465400401d13370e907f7fffffffffffffff80cc004dd59802980d1baa001808d221024c5000401d14a080c2266e9520003301c0014bd7044cc00c00cc078009018180e000a0348b202a8b202a8b202a8b202a44c8cc004004c01ccc008dd5980218091baa00a33014375201297ae02259800800c528c56600266e24dd6980b180b980b9bac301600148002266004004602e00314a08089014201e22323300100130040032259800800c52f5bded8c113322598009919800800803112cc00400629422b30013371e6eb8c06c0040122946266004004603800280b101944c8cc004004cc02801c00c896600200310038994c004dd7180c000cdd6980c800ccc00c00cc07400922259800980a80144006264646600200200644b300100189981099bb037520166e9800d2f5bded8c113233225980099b9100e0028acc004cdc780700144c96600266ebd300101a000374c003100289981299bb0375201e6e9800400902119198008009bab30230042259800800c4cc098cdd81ba900b375001497adef6c6089919912cc004cdc8807001456600266e3c03800a264b30013370e00266e05200000e880144cc0a8cdd81ba900f375066e000040380090261bad302700389981499bb0375201c6ea003401102544cc0a400ccc0140140050251bae3024001302900230270014095133024337606ea4038dd3003002204089981200199802802800a040375c603e002604800460440028100cc078cdd81ba9003375000497adef6c604068301b0014065100140506eb8c05c004cc008008c06000501518018018c028dd50031bae300c300937540066e1d20028b200e180400098019baa0088a4d13656400401";

/**
 * The UNAPPLIED `lp_intent.lp_intent.spend` compiled code (from `contracts/plutus.json`,
 * the post-audit set) — a committed public value, like `POOL_MINT_COMPILED_CODE` above. The
 * `lp_intent` validator is parameterised by the settlement credential `S`: apply
 * `Credential::Script(SETTLEMENT_HASH)` to this code (`applyParamsToScript`) then hash it
 * (`resolveScriptHash`) to get the real `lp_intent` script hash, and build its ENTERPRISE
 * (stake = None, never `S`-tagged) address from that. That derivation lives in
 * `lpIntentScript.ts` (it needs `@meshsdk/core`, so it stays out of this pure data module).
 * The unapplied hash is `05451fe2221473ae208676b78248af3f097155fe69ed433c8e8fa100`; the
 * S-applied hash is derived + pinned by `lpIntentScript.test.ts`.
 */
export const LP_INTENT_COMPILED_CODE =
  "590b5d010100229800aba2aba1aba0aab9faab9eaab9dab9a488888896600264653001300800198041804800cdc3a400530080024888966002600460106ea800e2653001300d00198069807000cdc3a400091119912cc004c00c0062b3001300f37540150028b20208acc004c0200062b3001300f37540150028b20208b201a40342b30013001300c37540051332259800980198071baa00a8cc0048c04cc050c050c0500064602660286028602860286028602800323013301400191119199119801001000912cc004006007132325980099b910060018acc004cdc7803000c4dd6980b801401501544cc010010c06c00d0151bae30150013018001405864646600200200c44b3001001801c4c8c96600266e440200062b30013371e0100031375660300050054059133004004301c00340586eb8c058004c0640050170a5eb7bdb18052000912cc004c014c040dd500144c8c8cc896600260320070058b202c375c602c0026eb8c058008c058004c044dd500145900f488c8cc00400400c896600200314bd7044cc8966002600a00513301700233004004001899802002000a02630160013017001405123013301430143014301400191809980a180a000c8c04cc050c050c050c050c050c050c0500066e0520009ba5480012222222222233229800912cc004cdc7a4500375c6042603c6ea8006266e0120ff91f4019800801522100a44100403113300400200140712298008015220100a44100800a00691119198008009bac300a3020375400844b30010018a508acc004c9660026644b30013375e604e60486ea800cc02ccc098008cc09966002603060466ea8006260166604c60166604c604e60486ea80052f5c097ae08a60103d87a8000408897ae0899baf4c103d87a800030153024375400714a08110c094c088dd5002980898111baa005899baf3011302237540026e9801229410201812000c528c4cc008008c09400501f2044488966003300132330010013756602060406ea8060896600200314a115980099baf302030240010278a518998010011812800a03e40894a14a280ea264b30013014301f375400313232598009813198071bac302530223754034466ebcc098c08cdd5181318119baa3012302337540020051325980099baf4c0101a000300e30233754037132598009814000c4cc89660026054003133225980099b8748010c09cdd5000c4c8c966002603c60526ea800a2646464646465300130330019819802cc0cc0126eb4c0cc00e6eb4c0cc0092222259800981c80344cc088c0e002c4cc0880104cc08800c4c96600260540031323259800981e001403e2c81c8dd7181d000981b1baa0068acc004c0bc00626464b3001303c002807c590391bae303a0013036375400d1640d081a0c0d0dd5002c590360c0cc004c0c8004c0c4004c0c0004c0bc004c0a8dd50014590280acc004cdd7981618149baa00130133029375403919800980819815981618149baa30133029375403866056980103424c50004bd704cc034dd5980c18149baa30183029375400a603060526ea80066601a6eacc060c0a4dd5180c18149baa0053013302937540033300d3756603060526ea800cc060c0a4dd5000ccc034dd5980c18149baa0033013302937540029111119912cc004cc8966002605660626ea800a29462b30013026303137540031337126eb4c0d4c0c8dd50009bad30353032375400514a08181030181118181baa0233259800981518181baa0018980c19819981a18189baa0014bd7045300103d87a800040bc606660606ea8c07cc0c0dd5180c98181baa0288992cc004c004dd6980d18189baa0248acc004c0a8c0c0dd5181118189baa0248992cc004cdc4a400400315980099b8733702006008003133225980099b89375a603e60686ea809c00a2b3001337126eb4c0dcc0e0c0e0c0e0c0e0c0e0c0d0dd5013800c56600260080051598009802000c4c96600266e1c00ccdc199b8200b0040018acc004cdc380119b833370401400800315980099baf30243035375401e6e9a6003300198009bab3024303537546048606a6ea80466eb8c0e0c0d4dd51812181a9baa00d9bae3024303537546048606a6ea8036603a00680d26eb8c0e0c0d4dd5180f981a9baa00d9bae302430353754603e606a6ea8036603a00480d26eb8c0e0c0d4dd50064dd71812181a9baa00c80220348cc0040b6051330189800cc0066002027375c6070606a6ea80326eb8c090c0d4dd50064c07401101a4dd7181c181a9baa30243035375401b375c6048606a6ea8c090c0d4dd5006c00d01a4dd7181c181a9baa301f3035375401b375c6048606a6ea8c07cc0d4dd5006c00901a180e9bad301e3035375405080ba2c819a2c819a2c8198cdc0a41fdfffffffffffffffe0200d1640c91640c91640c91640c866e04020018cdc0803802c590304590301980b80780444c96600266e2120000018992cc004cdc49bad30233033375404c00315980099b894800800626644b300130050028acc004c0140062b30013370e00466e0ccdc02400266e00cdc1001805802002456600266e1c004cdc199b8048004cdc019b8200300a0040048acc004cdd79812181a9baa00f374d30019800cc004dd59812181a9baa302430353754023375c6070606a6ea8c090c0d4dd5006cdd71812181a9baa30243035375401b0024069375c6070606a6ea8c07cc0d4dd5006cdd71812181a9baa301f3035375401b0014069375c6070606a6ea80326eb8c090c0d4dd50064c07400d01a46600205b0289980c4c006600330010139bae3038303537546048606a6ea80366eb8c090c0d4dd51812181a9baa00d980e80120349bae303830353754603e606a6ea80366eb8c090c0d4dd5180f981a9baa00d980e800a0349bae303830353754019375c6048606a6ea803200680d0c074dd6980f181a9baa028405d1640cd1640cd1640cd1640cd1640cc66e0401c024cdc080300445903145903119b810040038b206033702907f7fffffffffffffff80801a05e8b205e3712900045902e1980a1bab301d302e3754603a605c6ea8028014cc050dd5980e98171baa008005459027181598141baa0018b204c3029001301030263754602a604c6ea800a2c8138c09c004cc040dd6180718121baa01c2301e3300b37566028604a6ea8004c03cc094dd500c459025198079bac3026302337540364603a660146eacc04cc090dd5180998121baa001300e3024375402f1640846eacc044c088dd5180898111baa0028b2046302430213754604860426ea8c040c084dd5000981198101baa0018b203c32330010013758604660406ea8060896600200314c0103d87a80008992cc004cdd7981298111baa0010188980499812000a5eb82266006006604c0048100c09000502245901d08a6002005375c603e60386ea80066eb8c02cc070dd5000a0142222598009809000c4012264646600200200c44b300100189981199bb0375200c6e9800d2f5bded8c113233225980099b910090028acc004cdc780480144c96600266ebd30101a000374c003100289981399bb037520146e9800400902319198008009bab30250042259800800c4cc0a0cdd81ba900a375001297adef6c6089919912cc004cdc8806801456600266e3c03400a264b30013370e002602401b100289981619bb0375201c6ea0cdc00008068012050375a605200713302b337606ea4034dd4006002204e89981580199802802800a04e375c604c00260560046052002813a26604c66ec0dd48049ba600600440891330260033300500500140886eb8c084004c098008c0900050221981019bb037520046ea00052f5bded8c080e113259800980218079baa001899199119801001000912cc00400629422b30013371e6eb8c05800400e2946266004004602e00280890141bac3003301137540126eb8c04cc040dd5000c5900e180918079baa00240346020601a6ea80088c044c048c048c048c048c048c048c048c0480062c8058c030dd50040c024dd5001c590070c020004c00cdd5004452689b2b200201";
