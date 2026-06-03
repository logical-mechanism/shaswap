"use client";

/**
 * A small per-wallet activity log in localStorage. Blockfrost only surfaces a wallet's
 * *live* (unspent) orders, so without this a just-posted order is invisible until the
 * network indexes it, and a settled/reclaimed one vanishes with no trace. We record
 * what the user submitted (keyed by the owner = change address) so the Orders page can
 * show pending → open → settled/reclaimed, merged with the authoritative on-chain set.
 *
 * This is convenience state only — never a source of truth for funds. The chain is.
 */

export interface RecentOrder {
  /** Order output reference, `<txHash>#0`. */
  ref: string;
  txHash: string;
  inUnit: string;
  inTicker: string;
  inDecimals: number;
  outTicker: string;
  outDecimals: number;
  /** Base units. */
  amountIn: string;
  /** Floor (limit), base units. */
  minOut: string;
  partial: boolean;
  /** Date.now() at submit. */
  ts: number;
  /**
   * Timestamp we FIRST observed this order live on-chain. Until it's set, the order is
   * only "pending" (still confirming) — indexer lag must never flip a not-yet-indexed
   * order to a terminal state. Once set, a later disappearance is the terminal signal.
   */
  seenLive?: number;
  /** Set once the owner reclaims it. */
  reclaimTx?: string;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // forget after a day
const MAX_ENTRIES = 30;
const keyFor = (owner: string) => `shaswap:recent:${owner}`;

function read(owner: string): RecentOrder[] {
  if (typeof window === "undefined" || !owner) return [];
  try {
    const raw = window.localStorage.getItem(keyFor(owner));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr as RecentOrder[]) : [];
  } catch {
    return [];
  }
}

function write(owner: string, list: RecentOrder[]): void {
  if (typeof window === "undefined" || !owner) return;
  try {
    window.localStorage.setItem(
      keyFor(owner),
      JSON.stringify(list.slice(0, MAX_ENTRIES)),
    );
  } catch {
    // storage full / disabled → silently skip; it's convenience state only
  }
}

function prune(list: RecentOrder[], now: number): RecentOrder[] {
  return list.filter((o) => now - o.ts < MAX_AGE_MS);
}

/** Record a freshly-posted order (dedup by ref). */
export function recordPost(owner: string, order: RecentOrder): void {
  const list = prune(read(owner), order.ts);
  write(owner, [order, ...list.filter((o) => o.ref !== order.ref)]);
}

/**
 * Stamp the first on-chain observation for any logged `refs` not yet marked. Lets the
 * Orders view keep a just-posted order "pending" (and auto-refreshing) until it's
 * positively seen on-chain at least once, so a slow indexer can't reclassify a live
 * order as terminal. Persists only when something actually changed.
 */
export function markSeen(owner: string, refs: string[], now: number): void {
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

/** Recent orders for a wallet, pruned of stale entries (prune persisted only if any). */
export function getRecent(owner: string, now: number): RecentOrder[] {
  const all = read(owner);
  const list = prune(all, now);
  if (list.length !== all.length) write(owner, list); // only write when something expired
  return list;
}
