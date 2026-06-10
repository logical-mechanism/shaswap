/**
 * Merge the authoritative on-chain order set (Blockfrost, live UTXOs only) with the
 * local activity log (localStorage) into a single ordered list for the Orders page:
 * pending → open → settled/reclaimed. Pure and side-effect-free so it can be unit
 * tested (`orderRows.test.ts`).
 *
 * The chain is the source of truth: a live order is always "open" (reclaimable). The
 * local log only adds what the chain can't show yet — a just-posted order not yet
 * indexed ("pending"), or an order that has since left the set ("completed" once it has
 * been seen on-chain and then vanished, "reclaimed" if we hold a reclaim tx for it).
 *
 * "completed" is deliberately HONEST, not "settled": the app never verifies *how* an
 * order left the order address (solver settlement, a reclaim on another device, a
 * partial-fill remainder, a dropped tx). It only knows the UTXO is gone — so the label,
 * and any copy, must point the user to the explorer rather than claim a confirmed trade.
 */

import type { WalletPosition } from "@/lib/data";
import type { RecentOrder } from "./activity";

export type RowStatus = "pending" | "open" | "completed" | "reclaimed";

export interface OrderRow {
  ref: string;
  inTicker: string;
  inDecimals: number;
  outTicker: string;
  outDecimals: number;
  amountIn: string;
  minOut: string;
  partial: boolean;
  status: RowStatus;
  reclaimTx?: string;
  /** Only live on-chain orders are reclaimable. */
  canReclaim: boolean;
  /**
   * Settle-by deadline (POSIX ms) for a live/resting order, or null. Only carried for live
   * on-chain rows — the local activity log (pending/completed/reclaimed) doesn't record it.
   */
  deadline?: string | null;
}

/**
 * Fallback only: a recent post we've NEVER observed on-chain stays "pending" for this
 * long, after which we assume it never landed and show it as terminal — so a
 * dropped/never-indexed tx doesn't sit "pending" forever. This window is generous
 * (covers real indexer + mempool delay); an order positively seen on-chain is never
 * bound by it (only its later disappearance is terminal). Replaces the old fixed 3-min
 * cutoff that wrongly reclassified still-confirming orders.
 */
export const OBSERVE_FALLBACK_MS = 30 * 60 * 1000;

const STATUS_ORDER: Record<RowStatus, number> = {
  pending: 0,
  open: 1,
  reclaimed: 2,
  completed: 3,
};

export function mergeRows(
  live: WalletPosition[],
  recent: RecentOrder[],
  now: number,
): OrderRow[] {
  const recentByRef = new Map(recent.map((o) => [o.ref, o]));
  const rows: OrderRow[] = [];
  const seen = new Set<string>();

  // 1) Live on-chain orders are authoritative and reclaimable — unless we've already
  //    reclaimed one locally and the chain just hasn't caught up (handled in step 2).
  for (const o of live) {
    if (recentByRef.get(o.ref)?.reclaimTx) continue;
    rows.push({
      ref: o.ref,
      inTicker: o.tokenIn.ticker,
      inDecimals: o.tokenIn.decimals,
      outTicker: o.tokenOut.ticker,
      outDecimals: o.tokenOut.decimals,
      amountIn: o.amountIn,
      minOut: o.minOut,
      partial: o.partial,
      status: "open",
      canReclaim: true,
      deadline: o.deadline,
    });
    seen.add(o.ref);
  }

  // 2) Recent local entries the live set doesn't cover: pending / completed / reclaimed.
  //    An order stays "pending" until we've positively seen it on-chain at least once
  //    (`seenLive`); only a SUBSEQUENT disappearance is terminal ("completed"). A post
  //    never observed at all falls back to terminal after OBSERVE_FALLBACK_MS so a
  //    dropped tx doesn't sit "pending" forever.
  for (const r of recent) {
    if (seen.has(r.ref)) continue;
    const status: RowStatus = r.reclaimTx
      ? "reclaimed"
      : r.seenLive !== undefined
        ? "completed"
        : now - r.ts < OBSERVE_FALLBACK_MS
          ? "pending"
          : "completed";
    rows.push({
      ref: r.ref,
      inTicker: r.inTicker,
      inDecimals: r.inDecimals,
      outTicker: r.outTicker,
      outDecimals: r.outDecimals,
      amountIn: r.amountIn,
      minOut: r.minOut,
      partial: r.partial,
      status,
      reclaimTx: r.reclaimTx,
      canReclaim: false,
    });
    seen.add(r.ref);
  }

  return rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

/** True if any order is still awaiting on-chain confirmation ("pending"). */
export function hasPending(rows: OrderRow[]): boolean {
  return rows.some((r) => r.status === "pending");
}

/**
 * A swap routed across several pool shards posts N pool-bound legs as outputs of ONE
 * transaction (see `postOrders`), so every leg's `ref` (`<txHash>#<index>`) shares the
 * same `txHash`. Grouping by that hash reassembles a split swap into a single visual unit;
 * a plain single-pool swap is one row → a group of one.
 */
export interface OrderRowGroup {
  /** The shared post-transaction hash — every leg is an output of this one tx. */
  txHash: string;
  /** The legs of the swap, ordered by output index (so a split reads leg 1, 2, …). */
  legs: OrderRow[];
}

/**
 * Group merged rows by their post-transaction hash. Group order follows first appearance
 * in `rows` (which `mergeRows` has already sorted by status, so a group with active legs
 * leads); legs WITHIN a group are reordered into output-index order so a split always reads
 * leg 1, leg 2, … regardless of each leg's individual status. Pure and side-effect-free.
 */
export function groupRowsByTx(rows: OrderRow[]): OrderRowGroup[] {
  const byTx = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const txHash = row.ref.split("#")[0];
    const legs = byTx.get(txHash);
    if (legs) legs.push(row);
    else byTx.set(txHash, [row]);
  }
  return Array.from(byTx, ([txHash, legs]) => ({
    txHash,
    legs: [...legs].sort((a, b) => legIndex(a.ref) - legIndex(b.ref)),
  }));
}

/** The output index of an order ref (`<txHash>#<index>`); 0 if absent or malformed. */
function legIndex(ref: string): number {
  const n = Number.parseInt(ref.split("#")[1] ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Total input across a group's legs (sum of `amountIn`), base units, exact via BigInt. */
export function groupTotalIn(legs: OrderRow[]): string {
  return sumField(legs, "amountIn");
}

/** Combined floor across a group's legs (sum of `minOut`), base units, exact via BigInt. */
export function groupFloor(legs: OrderRow[]): string {
  return sumField(legs, "minOut");
}

function sumField(legs: OrderRow[], field: "amountIn" | "minOut"): string {
  let total = 0n;
  for (const l of legs) total += safeBig(l[field]);
  return total.toString();
}

/** Parse a base-unit integer string to BigInt, tolerating a malformed value as 0. */
function safeBig(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
