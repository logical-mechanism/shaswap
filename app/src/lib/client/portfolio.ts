/**
 * Pure aggregation for the Portfolio summary page — turns the wallet's merged order / LP rows
 * and its raw asset list into the headline counts the summary cards show. Side-effect-free so
 * the Node test runner (`portfolio.test.ts`) can pin it without a DOM or a wallet.
 *
 * The page does the fetching (the read-only hooks) and the live↔log merging (`mergeRows` /
 * `mergeLpIntentRows`); this module only COUNTS, so the numbers the cards show are derived the
 * exact same way as the detail pages they link into (no second source of truth).
 */

import type { TokenInfo } from "@/lib/data";
import type { RowStatus } from "./orderRows";

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
  /** Distinct recognised fungible tokens held (non-ADA, in the tradeable registry, qty > 0). */
  count: number;
  /** Their tickers, in registry order, for a friendly inline list. */
  tickers: string[];
  /**
   * Distinct non-ADA holdings the registry does NOT name — unrecognised fungibles or NFTs — so
   * the wallet card can stay honest (claim "just ADA" only when there's genuinely nothing else).
   */
  otherCount: number;
}

/**
 * Summarise the wallet's fungible-token holdings against the app's tradeable registry.
 *
 * `useAssets()` already excludes lovelace, but a `"lovelace"` unit is skipped defensively too —
 * ADA is shown separately. We only count and name tokens the app RECOGNISES (those in the
 * `useTokens()` registry): the Portfolio is a view of tradeable capital, and an unrecognised
 * asset has no ticker / decimals we could honestly surface (it may even be an NFT). Holdings are
 * summed per unit with BigInt (a malformed quantity counts as 0), and tickers come out in
 * registry order so the list is stable regardless of the wallet's asset ordering. Pure.
 */
export function summarizeWalletTokens(
  assets: ReadonlyArray<HeldAsset> | undefined,
  tokens: ReadonlyArray<TokenInfo>,
): WalletTokenSummary {
  const held = new Map<string, bigint>();
  for (const a of assets ?? []) {
    if (a.unit === "lovelace") continue;
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
  // `held` holds every non-ADA unit with a positive balance; the recognised ones become tickers,
  // so whatever's left is unrecognised (other fungibles or NFTs the registry can't name).
  return { count: tickers.length, tickers, otherCount: held.size - tickers.length };
}
