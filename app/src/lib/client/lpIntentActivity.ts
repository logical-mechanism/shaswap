"use client";

/**
 * A small per-wallet activity log in localStorage for batcher-fulfilled LP intents — the LP
 * analogue of `activity.ts`. The provider only surfaces a wallet's *live* (unspent) intents,
 * so without this a just-posted intent is invisible until indexed, and a fulfilled/reclaimed
 * one vanishes with no trace. We record what the user submitted (keyed by the owner = change
 * address) so the LP-intent surface can show pending → open → completed/reclaimed, merged with
 * the authoritative on-chain set.
 *
 * Convenience state only — never a source of truth for funds. The chain is.
 */

import type { LpIntentKind } from "@/lib/data";

export interface RecentLpIntent {
  /** Intent output reference, `<txHash>#0`. */
  ref: string;
  txHash: string;
  /** Pool NFT unit — so the per-pool surface filters to its own intents. */
  poolNft: string;
  action: LpIntentKind;
  aTicker: string;
  aDecimals: number;
  bTicker: string;
  bDecimals: number;
  /** Withdraw: LP redeemed (base units). */
  lp?: string;
  /** Deposit: asset_a / asset_b added (base units). */
  depositA?: string;
  depositB?: string;
  /** Solver tip (lovelace). */
  tip: string;
  /** Date.now() at submit. */
  ts: number;
  /** First time we observed it live on-chain (until set, it's only "pending"). */
  seenLive?: number;
  /** Set once the owner reclaims it. */
  reclaimTx?: string;
  /** Date.now() when the reclaim was submitted. */
  reclaimTs?: number;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // forget after a day
const MAX_ENTRIES = 30;
const keyFor = (owner: string) => `shaswap:lpintents:${owner}`;

function read(owner: string): RecentLpIntent[] {
  if (typeof window === "undefined" || !owner) return [];
  try {
    const raw = window.localStorage.getItem(keyFor(owner));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as RecentLpIntent[]) : [];
  } catch {
    return [];
  }
}

function write(owner: string, list: RecentLpIntent[]): void {
  if (typeof window === "undefined" || !owner) return;
  try {
    window.localStorage.setItem(
      keyFor(owner),
      JSON.stringify(list.slice(0, MAX_ENTRIES)),
    );
  } catch {
    // storage full / disabled → silently skip; convenience state only
  }
}

function prune(list: RecentLpIntent[], now: number): RecentLpIntent[] {
  return list.filter((o) => now - o.ts < MAX_AGE_MS);
}

/** Record a freshly-posted (or reclaimed) intent (dedup by ref). */
export function recordLpIntent(owner: string, intent: RecentLpIntent): void {
  const list = prune(read(owner), intent.ts);
  write(owner, [intent, ...list.filter((o) => o.ref !== intent.ref)]);
}

/** Stamp the first on-chain observation for any logged `refs` not yet marked. */
export function markLpSeen(owner: string, refs: string[], now: number): void {
  if (typeof window === "undefined" || !owner || refs.length === 0) return;
  const set = new Set(refs);
  const list = read(owner);
  let changed = false;
  const next = list.map((o) => {
    if (o.seenLive === undefined && set.has(o.ref)) {
      changed = true;
      return { ...o, seenLive: now };
    }
    return o;
  });
  if (changed) write(owner, next);
}

/**
 * Drop a stale optimistic reclaim (its tx never confirmed — lost a race / dropped). Stamps
 * `seenLive` if absent — a reclaim only ever targets a LIVE intent, so a reclaimed entry was,
 * by definition, live at least once — so the cleared row reads "completed" rather than briefly
 * bouncing back to "pending". (Mirrors `activity.ts:clearReclaim`; the `?? now` is the same
 * deliberate choice — in practice `onReclaim` already records `seenLive`, so it rarely fires.)
 */
export function clearLpReclaim(owner: string, ref: string, now: number): void {
  if (typeof window === "undefined" || !owner) return;
  const list = read(owner);
  let changed = false;
  const next = list.map((o) => {
    if (o.ref !== ref || o.reclaimTx === undefined) return o;
    changed = true;
    return { ...o, reclaimTx: undefined, reclaimTs: undefined, seenLive: o.seenLive ?? now };
  });
  if (changed) write(owner, next);
}

/** Recent intents for a wallet, pruned of stale entries (persisted only if any expired). */
export function getRecentLpIntents(owner: string, now: number): RecentLpIntent[] {
  const all = read(owner);
  const list = prune(all, now);
  if (list.length !== all.length) write(owner, list);
  return list;
}
