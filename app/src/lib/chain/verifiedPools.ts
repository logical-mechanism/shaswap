/**
 * Verified-pool surface — a curated trust layer over permissionless discovery.
 *
 * Pool creation is permissionless and the validators are immutable, so anyone can create
 * a pool with any (well-formed, ≤ cap) fee and any pair. Discovery alone gives a trader no
 * way to tell an official/known-good pool from a look-alike or a high-fee one. This module
 * is the allowlist the dApp badges as "Verified" — it is a UI hint ONLY and confers no
 * on-chain privilege whatsoever; an unverified pool is still fully tradeable.
 *
 * Identity is the pool's NFT unit (`policyId(56) + nft_name`), which is unique per pool
 * (each pool has its own one-shot mint policy). Populate per network at launch from the
 * bootstrap set (see documentation/spec/liquidity-bootstrap.md). Kept network-keyed so a
 * preprod id can never mark a mainnet pool verified.
 */

import { APP_CONFIG, type Network } from "../config.ts";

/**
 * Per-network set of verified pool NFT units (lowercase `policy+name` hex). Seed these at
 * launch with the canonical bootstrap pools; community pools remain unverified-but-usable.
 */
const VERIFIED_POOL_NFTS: Record<Network, ReadonlySet<string>> = {
  preprod: new Set<string>([
    // e.g. "<policyId>4e4654" — add the preprod canonical pools here.
  ]),
  preview: new Set<string>([]),
  mainnet: new Set<string>([
    // None verified yet — mainnet launched 2026-06-08 with an empty market. Add each
    // bootstrap/canonical pool's NFT unit here as it is created (see
    // documentation/spec/liquidity-bootstrap.md).
  ]),
};

const ACTIVE_VERIFIED = VERIFIED_POOL_NFTS[APP_CONFIG.network];

/**
 * Is this pool on the active network's verified allowlist? Case-insensitive on the NFT
 * unit. A non-hit is NOT a warning by itself (most pools are community pools) — it just
 * means "no positive trust signal"; pair it with the high-fee / price-impact cautions.
 */
export function isVerifiedPool(poolNftUnit: string | undefined): boolean {
  if (!poolNftUnit) return false;
  return ACTIVE_VERIFIED.has(poolNftUnit.toLowerCase());
}

/** Count of verified pools on the active network (diagnostics / tests). */
export const verifiedPoolCount = ACTIVE_VERIFIED.size;
