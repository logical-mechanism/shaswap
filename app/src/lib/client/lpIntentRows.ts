/**
 * Merge the authoritative on-chain LP-intent set (live UTXOs only) with the local activity
 * log into a single ordered list for the LP-intent surface: pending → open →
 * completed/reclaimed. The LP analogue of `orderRows.ts` — pure and side-effect-free
 * (`lpIntentRows.test.ts`).
 *
 * The chain is the source of truth: a live intent is always "open" (reclaimable). The local
 * log only adds what the chain can't show yet — a just-posted intent not yet indexed
 * ("pending"), or an intent that has since left the set ("completed" once seen on-chain and
 * then gone — fulfilled by a batcher or reclaimed elsewhere; "reclaimed" if we hold a reclaim
 * tx for it). "completed" is HONEST, not "fulfilled": the app only knows the UTXO is gone.
 */

import type { LpIntentKind, LpIntentPosition } from "@/lib/data";
import type { RecentLpIntent } from "./lpIntentActivity";
import type { RowStatus } from "./orderRows";

export type { RowStatus } from "./orderRows";

/**
 * A never-seen post past this window is shown terminal so a dropped/never-indexed tx doesn't
 * sit "pending" forever. Same window as `orderRows.OBSERVE_FALLBACK_MS` (inlined, not
 * value-imported: this file is exercised by the Node test runner, which can't resolve an
 * extensionless relative VALUE import — and the build forbids the `.ts` extension; type-only
 * imports above are erased, so they're fine. `lpIntentRows.test.ts` cross-checks the boundary
 * against the canonical `orderRows` export, catching any divergence).
 */
const OBSERVE_FALLBACK_MS = 30 * 60 * 1000;

export interface LpIntentRow {
  ref: string;
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
  tip: string;
  status: RowStatus;
  reclaimTx?: string;
  /** Only live on-chain intents are reclaimable. */
  canReclaim: boolean;
}

const STATUS_ORDER: Record<RowStatus, number> = {
  pending: 0,
  open: 1,
  reclaimed: 2,
  completed: 3,
};

/** A live position → row (always open + reclaimable). */
function fromLive(o: LpIntentPosition): LpIntentRow {
  return {
    ref: o.ref,
    action: o.action,
    aTicker: o.tokenA.ticker,
    aDecimals: o.tokenA.decimals,
    bTicker: o.tokenB.ticker,
    bDecimals: o.tokenB.decimals,
    lp: o.lp,
    depositA: o.depositA,
    depositB: o.depositB,
    tip: o.tip,
    status: "open",
    canReclaim: true,
  };
}

/** A local entry the live set doesn't cover → pending / completed / reclaimed. */
function fromRecent(r: RecentLpIntent, now: number): LpIntentRow {
  const status: RowStatus = r.reclaimTx
    ? "reclaimed"
    : r.seenLive !== undefined
      ? "completed"
      : now - r.ts < OBSERVE_FALLBACK_MS
        ? "pending"
        : "completed";
  return {
    ref: r.ref,
    action: r.action,
    aTicker: r.aTicker,
    aDecimals: r.aDecimals,
    bTicker: r.bTicker,
    bDecimals: r.bDecimals,
    lp: r.lp,
    depositA: r.depositA,
    depositB: r.depositB,
    tip: r.tip,
    status,
    reclaimTx: r.reclaimTx,
    canReclaim: false,
  };
}

/**
 * Merge live + recent into the displayed rows. `live`/`recent` are already filtered to the
 * pool of interest by the caller (the panel is per-pool). Mirrors `mergeRows`.
 */
export function mergeLpIntentRows(
  live: LpIntentPosition[],
  recent: RecentLpIntent[],
  now: number,
): LpIntentRow[] {
  const recentByRef = new Map(recent.map((o) => [o.ref, o]));
  const rows: LpIntentRow[] = [];
  const seen = new Set<string>();

  // 1) Live on-chain intents are authoritative + reclaimable — unless already reclaimed locally.
  for (const o of live) {
    if (recentByRef.get(o.ref)?.reclaimTx) continue;
    rows.push(fromLive(o));
    seen.add(o.ref);
  }

  // 2) Recent local entries the live set doesn't cover.
  for (const r of recent) {
    if (seen.has(r.ref)) continue;
    rows.push(fromRecent(r, now));
    seen.add(r.ref);
  }

  return rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}
