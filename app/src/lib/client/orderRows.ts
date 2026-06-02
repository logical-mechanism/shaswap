/**
 * Merge the authoritative on-chain order set (Blockfrost, live UTXOs only) with the
 * local activity log (localStorage) into a single ordered list for the Orders page:
 * pending → open → settled/reclaimed. Pure and side-effect-free so it can be unit
 * tested (`orderRows.test.ts`).
 *
 * The chain is the source of truth: a live order is always "open" (reclaimable). The
 * local log only adds what the chain can't show yet — a just-posted order not yet
 * indexed ("pending"), or an order that has since left the set ("settled" if it just
 * vanished, "reclaimed" if we hold a reclaim tx for it).
 */

import type { WalletPosition } from "@/lib/data";
import type { RecentOrder } from "./activity";

export type RowStatus = "pending" | "open" | "settled" | "reclaimed";

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
}

/** A recent post is "pending" (vs assumed-settled) for this long after submit. */
export const PENDING_MS = 3 * 60 * 1000;

const STATUS_ORDER: Record<RowStatus, number> = {
  pending: 0,
  open: 1,
  reclaimed: 2,
  settled: 3,
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
    });
    seen.add(o.ref);
  }

  // 2) Recent local entries the live set doesn't cover: pending / settled / reclaimed.
  for (const r of recent) {
    if (seen.has(r.ref)) continue;
    const status: RowStatus = r.reclaimTx
      ? "reclaimed"
      : now - r.ts < PENDING_MS
        ? "pending"
        : "settled";
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

/** True if any row is still awaiting confirmation (drives auto-refresh polling). */
export function hasPending(rows: OrderRow[]): boolean {
  return rows.some((r) => r.status === "pending");
}
