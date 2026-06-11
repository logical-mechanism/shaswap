/**
 * Pure aggregation for the Portfolio summary page — turns the wallet's merged order / LP rows
 * and its raw asset list into the headline counts the summary cards show. Side-effect-free so
 * the Node test runner (`portfolio.test.ts`) can pin it without a DOM or a wallet.
 *
 * The page does the fetching (the read-only hooks) and the live↔log merging (`mergeRows` /
 * `mergeLpIntentRows`); this module COUNTS resting rows, matches LP holdings to pools, and
 * summarises the wallet's tokens — all from already-fetched data, so the numbers the cards show
 * are derived the same way as the detail pages they link into (no second source of truth).
 */

import type { Pool, TokenInfo } from "@/lib/data";
import type { RowStatus } from "./orderRows";
// Relative `.ts` import (not the `@/` alias) so the Node test runner can resolve it — it strips
// types but doesn't honor the alias. `lpUnitForPool` is a pure, Mesh-free derivation.
import { lpUnitForPool } from "../chain/deployment.ts";

/**
 * How many rows are RESTING on-chain right now — status `open`, i.e. live and reclaimable.
 * Generic over any row carrying a `status` so it serves both order rows and LP-intent rows.
 */
export function countResting(rows: ReadonlyArray<{ status: RowStatus }>): number {
  return rows.reduce((n, r) => (r.status === "open" ? n + 1 : n), 0);
}

/** A wallet holding as returned by `useAssets()`: a unit + a base-unit quantity string. */
export interface HeldAsset {
  unit: string;
  quantity: string;
}

export interface WalletTokenSummary {
  /** Distinct recognized fungible tokens held (non-ADA, in the tradeable registry, qty > 0). */
  count: number;
  /** Their tickers, in registry order, for a friendly inline list. */
  tickers: string[];
  /**
   * Distinct non-ADA holdings the registry does NOT name — unrecognized fungibles or NFTs — so
   * the wallet card can stay honest (claim "just ADA" only when there's genuinely nothing else).
   */
  otherCount: number;
}

/**
 * Summarise the wallet's fungible-token holdings against the app's tradeable registry.
 *
 * `useAssets()` already excludes lovelace, but a `"lovelace"` unit is skipped defensively too —
 * ADA is shown separately. We only count and name tokens the app RECOGNIZES (those in the
 * `useTokens()` registry): the Portfolio is a view of tradeable capital, and an unrecognized
 * asset has no ticker / decimals we could honestly surface (it may even be an NFT). Holdings are
 * summed per unit with BigInt (a malformed quantity counts as 0), and tickers come out in
 * registry order so the list is stable regardless of the wallet's asset ordering. Pure.
 */
export function summarizeWalletTokens(
  assets: ReadonlyArray<HeldAsset> | undefined,
  tokens: ReadonlyArray<TokenInfo>,
  /** Units to leave out — e.g. LP tokens, which the Liquidity card surfaces as positions. */
  exclude?: ReadonlySet<string>,
): WalletTokenSummary {
  const held = new Map<string, bigint>();
  for (const a of assets ?? []) {
    if (a.unit === "lovelace") continue;
    if (exclude?.has(a.unit)) continue;
    let qty: bigint;
    try {
      qty = BigInt(a.quantity);
    } catch {
      qty = 0n;
    }
    if (qty <= 0n) continue;
    held.set(a.unit, (held.get(a.unit) ?? 0n) + qty);
  }

  const tickers: string[] = [];
  for (const t of tokens) {
    if (t.unit === "lovelace") continue;
    if ((held.get(t.unit) ?? 0n) > 0n) tickers.push(t.ticker);
  }
  // `held` holds every non-ADA unit with a positive balance; the recognized ones become tickers,
  // so whatever's left is unrecognized (other fungibles or NFTs the registry can't name).
  return { count: tickers.length, tickers, otherCount: held.size - tickers.length };
}

export interface LpPositionSummary {
  /** Distinct pools the wallet holds LP for — realized liquidity positions. */
  count: number;
  /** The pairs those positions are in, deduped, in pools order — for a friendly inline list. */
  pairs: string[];
  /** The matched LP-token units — so the wallet card can leave them out of its token tally. */
  lpUnits: string[];
}

/**
 * Match the wallet's holdings against each pool's LP token to surface realized liquidity
 * positions. Fully derivable on-chain — an LP balance is a proportional claim on the pool's
 * reserves — with no price feed or time series: `lpUnitForPool` maps a pool's NFT unit to its
 * LP unit, and a positive held balance of that unit is an open position in that pool. Counts
 * one position per pool (so two fee tiers of the same pair count as two), but de-dupes the pair
 * LABELS for display. A malformed pool id is skipped, never thrown on. Pure + testable.
 */
export function lpPositions(
  pools: ReadonlyArray<Pool>,
  assets: ReadonlyArray<HeldAsset> | undefined,
): LpPositionSummary {
  const held = new Set<string>();
  for (const a of assets ?? []) {
    let qty: bigint;
    try {
      qty = BigInt(a.quantity);
    } catch {
      qty = 0n;
    }
    if (qty > 0n) held.add(a.unit);
  }

  const pairs: string[] = [];
  const lpUnits: string[] = [];
  const seenPair = new Set<string>();
  let count = 0;
  for (const p of pools) {
    let lpUnit: string;
    try {
      lpUnit = lpUnitForPool(p.id);
    } catch {
      continue;
    }
    if (!held.has(lpUnit)) continue;
    count += 1;
    lpUnits.push(lpUnit);
    const pair = `${p.tokenA.ticker}/${p.tokenB.ticker}`;
    if (!seenPair.has(pair)) {
      seenPair.add(pair);
      pairs.push(pair);
    }
  }
  return { count, pairs, lpUnits };
}
