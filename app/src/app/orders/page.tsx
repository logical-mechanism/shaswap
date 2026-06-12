"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/hooks";
import { useOrders } from "@/hooks/useOrders";
import { useWriteGate } from "@/hooks/useWriteGate";
import { useOwnerAddress } from "@/hooks/useOwnerAddress";
import {
  clearReclaim,
  getRecent,
  markSeen,
  recordPost,
  type RecentOrder,
} from "@/lib/client/activity";
import { fetchTxConfirmed } from "@/lib/client/api";
import { nowMs } from "@/lib/client/now";
import {
  groupFloor,
  groupRowsByTx,
  groupTotalIn,
  mergeRows,
  type OrderRow,
  type OrderRowGroup,
  type RowStatus,
} from "@/lib/client/orderRows";
import { toUserMessage } from "@/lib/client/errors";
import { explorerTxUrl } from "@/lib/config";
import { formatUnits, relativeFuture, truncate } from "@/lib/format";
import { Pip } from "@/components/Pip";
import { PipLoading } from "@/components/PipLoading";
import { PipOverlay } from "@/components/PipOverlay";
import { PipEmptyState } from "@/components/PipEmptyState";
import { Disclosure } from "@/components/Disclosure";
import { RefreshIcon } from "@/components/RefreshIcon";
import { CollateralNote } from "@/components/CollateralNote";

const STATUS_STYLE: Record<RowStatus, string> = {
  pending: "k-chip-info",
  open: "k-chip-accent",
  completed: "k-chip-muted",
  reclaimed: "k-chip-success",
};

/** Honest, plain-language explanation of each row state (badge tooltip + legend). */
const STATUS_HELP: Record<RowStatus, string> = {
  pending: "On its way onto the chain (~20–40s). Refresh in a moment to see it rest.",
  open: "Resting in the next batch, held at your floor. A solver may settle it at the batch price, and it's yours to grab back anytime.",
  completed:
    "Out of the basket. Settled by a solver, or grabbed back elsewhere. Check the explorer for the outcome.",
  reclaimed: "You grabbed this order back; the funds are home in your wallet.",
};

/** Cozy, honest labels for each state. "resting" is the dominant waiting state. */
const STATUS_LABEL: Record<RowStatus, string> = {
  pending: "arriving",
  open: "resting",
  completed: "out of the basket",
  reclaimed: "grabbed back",
};

/**
 * The honest, accessible status pill — shared by the single-order row and each split-swap
 * leg so the label + tooltip + sr-name stay identical wherever a status is shown.
 */
function StatusChip({ status }: { status: RowStatus }) {
  return (
    <span
      className={`k-chip ${STATUS_STYLE[status]} cursor-help`}
      tabIndex={0}
      title={STATUS_HELP[status]}
      aria-label={`${STATUS_LABEL[status]}: ${STATUS_HELP[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Grace window before the Orders view reconciles a logged entry against the chain — used
 * for BOTH an optimistic reclaim (verify its tx landed) and a "pending" post we never saw
 * live (verify the post landed). It's measured from the relevant tx's submit time and is
 * comfortably past confirmation + Blockfrost indexer lag, so we never act inside the brief
 * window where a tx is in a block but its effects aren't yet reflected in the address-UTXO
 * set. 5 min tidies up promptly without flickering a still-confirming tx.
 */
const RECONCILE_GRACE_MS = 5 * 60 * 1000;

type ReclaimState =
  | { kind: "idle" }
  | { kind: "busy"; ref: string }
  | { kind: "error"; ref: string; message: string };

export default function OrdersPage() {
  const { connected, wallet } = useWallet();
  // Reclaim spends a script UTXO — the same gating as every write flow (network +
  // collateral); shared via useWriteGate.
  const {
    networkReady,
    collateralReady,
    needsCollateral,
    recheckCollateral,
    // Shared connect → wrong-network → checking → collateral prefix (DRY with the swap
    // card + LP forms); the reclaim button shows it, else "Reclaim".
    baseReason,
  } = useWriteGate({ requireCollateral: true });
  // Query by the wallet's CHANGE address — the payment key hash orders are posted under
  // (`postOrder` uses getChangeAddress) — so HD wallets that rotate addresses still see their
  // own orders, and the local activity log keys match. Shared with the Portfolio page via
  // useOwnerAddress so both surfaces resolve the owner identically.
  const { ownerAddr, ownerError } = useOwnerAddress();

  const { orders, loading, error, reload } = useOrders(ownerAddr);
  const [recent, setRecent] = useState<RecentOrder[]>([]);
  const [now, setNow] = useState(0);
  const [reclaim, setReclaim] = useState<ReclaimState>({ kind: "idle" });
  // Synchronous re-entry latch (matches the other write flows) — a double-click would
  // otherwise fire two reclaims of the same order (the second dies BadInputsUTxO).
  const reclaiming = useRef(false);

  // Re-read the local activity log + refetch the live set. Only ever sets state from
  // here (a callback), never synchronously in an effect body. Also clears any stale
  // reclaim error so it isn't sticky across a refresh / status change.
  const refresh = useCallback(() => {
    reload();
    setRecent(ownerAddr ? getRecent(ownerAddr, nowMs()) : []);
    setNow(nowMs());
    setReclaim({ kind: "idle" });
  }, [ownerAddr, reload]);

  // Initial load when the owner resolves (deferred out of the effect body).
  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, [refresh]);

  // Whenever the live set resolves (on mount or a manual Refresh), stamp each live order
  // as positively observed on-chain (seenLive), then re-read the log. This keeps a
  // just-posted order "pending" through indexer lag until a refresh shows it live, and
  // makes a LATER disappearance the terminal signal — instead of a fixed timer guessing
  // "settled". Deferred per the project's effect convention.
  useEffect(() => {
    if (!ownerAddr || orders.length === 0) return;
    const id = setTimeout(() => {
      markSeen(ownerAddr, orders.map((o) => o.ref), nowMs());
      setRecent(getRecent(ownerAddr, nowMs()));
      setNow(nowMs());
    }, 0);
    return () => clearTimeout(id);
  }, [ownerAddr, orders]);

  // Reconcile logged entries against the chain — once on mount/Refresh, and via a single
  // re-armed one-shot timer so an idle tab self-corrects without a manual Refresh (bounded,
  // not interval polling). Two flows, both gated by RECONCILE_GRACE_MS (anchored on the tx's
  // submit time, `reclaimTs ?? ts`, so legacy entries with no reclaimTs still qualify):
  //
  //   • Optimistic reclaim: a reclaim and a settlement both spend the order UTXO, so a
  //     reclaim can lose a mempool race and never land, leaving a false "reclaimed ✓". Clear
  //     it ONLY when its tx is unconfirmed AND the order has LEFT the live set (the lost-race
  //     signal) — never flip a still-live order back to a clickable "open" that invites a
  //     doomed second reclaim. (Blockfrost drops the order from the live set only once it has
  //     indexed the spending block, when a WINNING reclaim's own tx is queryable too — so
  //     liveness gating also stops us clearing a genuine reclaim during indexer lag.)
  //
  //   • Stuck "pending" post: an order can be settled by a solver before we ever refresh
  //     while it's live, so it's never stamped seenLive and sits "pending" until the 30-min
  //     OBSERVE_FALLBACK. If its post tx IS on-chain yet the order is gone from the live set,
  //     it landed and has since been spent → stamp seenLive so the row reads "completed" now.
  //
  // Transient provider errors never act (leave the row, retry next pass); confirmed reclaims
  // are cached in-session so we don't re-query them. Deferred per the effect convention.
  const reclaimVerified = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ownerAddr) return;
    let cancelled = false;
    let rearm: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();

    // Entries still needing a chain check: an unconfirmed optimistic reclaim, or a pending
    // post we've never seen live (no seenLive, no reclaim).
    const needsWork = () =>
      getRecent(ownerAddr, nowMs()).filter(
        (o) =>
          (o.reclaimTx !== undefined && !reclaimVerified.current.has(o.reclaimTx)) ||
          (o.reclaimTx === undefined && o.seenLive === undefined),
      );
    // The entry's grace window elapses this far in the future (≤0 ⇒ already due).
    const dueIn = (o: RecentOrder) =>
      (o.reclaimTs ?? o.ts) + RECONCILE_GRACE_MS - nowMs();
    const isLive = (ref: string) => orders.some((p) => p.ref === ref);

    const runVerify = async () => {
      if (cancelled) return;
      let changed = false;
      for (const o of needsWork().filter((e) => dueIn(e) <= 0)) {
        if (cancelled) return;
        try {
          if (o.reclaimTx !== undefined) {
            if (await fetchTxConfirmed(o.reclaimTx, ac.signal)) {
              reclaimVerified.current.add(o.reclaimTx); // genuine reclaim — keep "reclaimed ✓"
            } else if (!isLive(o.ref)) {
              clearReclaim(ownerAddr, o.ref, nowMs()); // lost the race → honest "completed"
              changed = true;
            }
            // else: unconfirmed but still live → pending in the mempool; keep optimistic.
          } else if (
            !isLive(o.ref) &&
            (await fetchTxConfirmed(o.ref.split("#")[0], ac.signal))
          ) {
            // Pending post, gone from the live set, but its post tx IS on-chain → it landed
            // and was settled/spent before we saw it live. Stamp seenLive → "completed".
            markSeen(ownerAddr, [o.ref], nowMs());
            changed = true;
          }
        } catch {
          // transient provider error / aborted — leave the row as-is, retry next pass
        }
      }
      if (changed && !cancelled) {
        setRecent(getRecent(ownerAddr, nowMs()));
        setNow(nowMs());
      }
      // Self-correct an idle tab: fire once when the soonest not-yet-due item crosses its
      // grace window (a bounded one-shot, re-scheduled each pass — not interval polling).
      if (!cancelled) {
        const waits = needsWork().map(dueIn).filter((ms) => ms > 0);
        if (waits.length > 0) rearm = setTimeout(runVerify, Math.min(...waits));
      }
    };

    const id = setTimeout(runVerify, 0);
    return () => {
      cancelled = true;
      ac.abort();
      clearTimeout(id);
      if (rearm) clearTimeout(rearm);
    };
  }, [ownerAddr, orders]);

  const rows = useMemo(
    () => (ownerAddr ? mergeRows(orders, recent, now) : []),
    [ownerAddr, orders, recent, now],
  );

  // No interval polling — a just-posted order shows instantly as "pending" (the local
  // activity log), and the user hits Refresh to pull its on-chain confirmation once the
  // chain has indexed it (~20–40s). Keeps an idle tab off the shared Blockfrost quota
  // (see documentation/app-data-caching.md).

  async function onReclaim(row: OrderRow) {
    if (reclaiming.current) return;
    reclaiming.current = true;
    setReclaim({ kind: "busy", ref: row.ref });
    try {
      // Dynamically imported so @meshsdk/core (tx-building + WASM) stays out of the
      // initial bundle — only pulled in when the user actually reclaims.
      const { reclaimOrder } = await import("@/lib/client/tx");
      const hash = await reclaimOrder(wallet, row.ref);
      // Upsert a reclaimed entry (recordPost dedups by ref) so the row shows
      // "reclaimed" — and isn't offered for a doomed second reclaim — even while the
      // chain still lists it, and even for an order not previously in the local log
      // (a partial-fill remainder, cleared storage, or another device).
      if (ownerAddr) {
        recordPost(ownerAddr, {
          ref: row.ref,
          txHash: row.ref.split("#")[0],
          inUnit: "",
          inTicker: row.inTicker,
          inDecimals: row.inDecimals,
          outTicker: row.outTicker,
          outDecimals: row.outDecimals,
          amountIn: row.amountIn,
          minOut: row.minOut,
          partial: row.partial,
          ts: nowMs(),
          // Reclaim only targets a LIVE order, so it has been seen on-chain — stamp it so
          // that if this reclaim is later cleared (it lost a mempool race) the row reads
          // as "completed", not "pending". reclaimTs gates the on-chain verify grace window.
          seenLive: nowMs(),
          reclaimTx: hash,
          reclaimTs: nowMs(),
        });
      }
      setReclaim({ kind: "idle" });
      refresh();
    } catch (e) {
      setReclaim({ kind: "error", ref: row.ref, message: toUserMessage(e) });
    } finally {
      reclaiming.current = false;
    }
  }

  const showLoading =
    loading || (connected && ownerAddr === undefined && !ownerError);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Pip size={30} mood="happy" />
            <h1 className="font-display text-2xl font-extrabold text-ink">Orders</h1>
          </div>
          <p className="mt-1 text-sm text-muted">
            Everything you’ve dropped off. Resting orders are yours to grab back
            anytime.
          </p>
        </div>
        {connected && (
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-busy={loading}
            className="k-btn-ghost shrink-0 px-3 py-1.5 text-xs disabled:opacity-70"
          >
            <span className="flex items-center gap-1.5">
              <RefreshIcon busy={loading} />
              {loading ? "Refreshing…" : "Refresh"}
            </span>
          </button>
        )}
      </header>

      {connected && needsCollateral && (
        <CollateralNote onRecheck={recheckCollateral}>
          Grabbing an order back needs a collateral set in your wallet. Add one, then
          re-check.
        </CollateralNote>
      )}

      {!connected && (
        <PipEmptyState mood="wave" body="Connect a wallet and Pip will gather your resting orders." />
      )}

      {ownerError && (
        <div className="k-note k-note-danger flex items-center gap-2 p-4 text-sm">
          <Pip size={24} mood="calm" still />
          <span>Pip couldn’t read your wallet address. Reconnect and try again.</span>
        </div>
      )}

      {connected && error && (
        <div className="k-note k-note-danger p-4 text-sm">
          <div className="flex items-center gap-2">
            <Pip size={24} mood="calm" still />
            <span className="font-bold">Pip couldn’t gather your orders just now.</span>
          </div>
          <div className="mt-1 break-words text-xs text-muted">{error}</div>
          <button
            type="button"
            onClick={refresh}
            className="k-btn-danger-soft mt-2 px-3 py-1.5 text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {connected && showLoading && rows.length === 0 && (
        <PipLoading label="Pip’s checking the basket…" />
      )}

      {connected && !showLoading && !error && rows.length === 0 && (
        <PipEmptyState
          mood="sleepy"
          title="Your basket’s empty"
          body="Drop off an order from the Swap page and it’ll rest in the basket for the next batch."
        >
          <Link href="/" className="k-btn mt-4 px-4 py-2 text-sm">
            Drop off an order →
          </Link>
        </PipEmptyState>
      )}

      {connected && rows.length > 0 && (
        <OrderGroups
          rows={rows}
          now={now}
          reclaim={reclaim}
          baseReason={baseReason}
          networkReady={networkReady}
          collateralReady={collateralReady}
          onReclaim={onReclaim}
        />
      )}

      <PipOverlay
        show={reclaim.kind === "busy"}
        title="Grabbing your order back…"
      />
    </div>
  );
}

/**
 * Lay the orders out as a cozy "batch basket": resting orders get their own grouped section
 * (the waiting state, made to feel intentional) above a quieter "Recent activity" list. The
 * basket is a VISUAL grouping only — never a fabricated "basket #N", since the app can't know
 * which batch an order lands in (that would break the honest-labels invariant).
 */
function OrderGroups({
  rows,
  now,
  reclaim,
  baseReason,
  networkReady,
  collateralReady,
  onReclaim,
}: {
  rows: OrderRow[];
  now: number;
  reclaim: ReclaimState;
  baseReason: string | null;
  networkReady: boolean;
  collateralReady: boolean;
  onReclaim: (row: OrderRow) => void;
}) {
  // Group the flat row list by post-tx hash so a smart-order-routed swap (N legs posted in
  // one tx) reads as ONE basket; a plain single-pool swap is a group of one. A group rests
  // (sits in the resting section) if ANY of its legs is still open, else it's recent activity.
  const groups = groupRowsByTx(rows);
  const resting = groups.filter((g) => g.legs.some((l) => l.status === "open"));
  const others = groups.filter((g) => !g.legs.some((l) => l.status === "open"));
  // The chip + copy count resting ORDERS (open legs), not cards — a split holds several at
  // once. (Equals the old per-row count, so the number's meaning is unchanged.)
  const restingCount = rows.filter((r) => r.status === "open").length;

  const renderRow = (row: OrderRow) => (
    <OrderRowItem
      key={row.ref}
      row={row}
      now={now}
      busy={reclaim.kind === "busy" && reclaim.ref === row.ref}
      anyBusy={reclaim.kind === "busy"}
      error={
        reclaim.kind === "error" && reclaim.ref === row.ref ? reclaim.message : undefined
      }
      baseReason={baseReason}
      networkReady={networkReady}
      collateralReady={collateralReady}
      onReclaim={() => onReclaim(row)}
    />
  );

  // A singleton renders exactly as before (the unchanged single-order row); a multi-leg
  // split renders as one grouped card with each leg visible and independently reclaimable.
  const renderGroup = (group: OrderRowGroup) =>
    group.legs.length === 1 ? (
      renderRow(group.legs[0])
    ) : (
      <OrderGroupCard
        key={group.txHash}
        group={group}
        now={now}
        reclaim={reclaim}
        baseReason={baseReason}
        networkReady={networkReady}
        collateralReady={collateralReady}
        onReclaim={onReclaim}
      />
    );

  return (
    <div className="space-y-6">
      {resting.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Pip size={26} mood="sleepy" />
            <h2 className="font-display text-base font-extrabold text-ink">
              Resting in the next batch
            </h2>
            <span className="k-chip k-chip-accent">{restingCount}</span>
          </div>
          <p className="mb-3 text-xs text-muted">
            Held at your floor until the batch settles, and always yours to grab back.
          </p>
          <Disclosure summary="Why is my order just resting?" className="mb-3">
            <div className="k-note k-note-info flex gap-3 text-xs leading-relaxed">
              <span className="shrink-0">
                <Pip size={30} mood="thinking" />
              </span>
              <div className="space-y-2">
                <p>
                  You don’t trade on the spot. Every little while, all the orders for a pair
                  settle together at one shared price, so no one can sneak in front of you
                  to move it.
                </p>
                <p>
                  Your order rests at the floor you set until that happens, or until you grab
                  it back. It can fill whenever the market reaches your floor.
                </p>
              </div>
            </div>
          </Disclosure>
          <ul className="space-y-2">{resting.map(renderGroup)}</ul>
        </section>
      )}

      {others.length > 0 && (
        <section>
          {resting.length > 0 && (
            <h2 className="mb-2 font-display text-base font-extrabold text-ink">
              Recent activity
            </h2>
          )}
          <ul className="space-y-2">{others.map(renderGroup)}</ul>
        </section>
      )}
    </div>
  );
}

/**
 * A smart-order-routed swap rendered as ONE basket: the legs of a single split (posted in
 * one tx by `postOrders`) grouped so the split reads as a unit instead of N stray rows. The
 * header states the WHOLE swap — total in → out, combined floor, and "routed across N pools"
 * (a fact about the post, never a fabricated batch number). Each leg keeps its OWN honest
 * status chip and its own "grab back" (reclaim is per-order), so a mixed group (one settled,
 * one resting, one grabbed back) reads truthfully — the card never claims a single status.
 */
function OrderGroupCard({
  group,
  now,
  reclaim,
  baseReason,
  networkReady,
  collateralReady,
  onReclaim,
}: {
  group: OrderRowGroup;
  now: number;
  reclaim: ReclaimState;
  baseReason: string | null;
  networkReady: boolean;
  collateralReady: boolean;
  onReclaim: (row: OrderRow) => void;
}) {
  const { txHash, legs } = group;
  // Every leg is the same pair (one swap), so read the display units off the first leg.
  const head = legs[0];
  // The header describes the swap AS POSTED — total input and combined floor summed across
  // ALL legs — exactly as a single order's header shows its posted amount + floor whatever
  // its status (OrderRowItem). Current state is conveyed PER-LEG by each leg's status chip,
  // never collapsed up here; summing only open legs would wrongly zero out a settled group.
  const totalIn = groupTotalIn(legs);
  const floor = groupFloor(legs);
  const anyPartial = legs.some((l) => l.partial);
  const anyOpen = legs.some((l) => l.status === "open");
  const anyReclaimable = legs.some((l) => l.canReclaim);
  // Reclaims are serialized by one global latch, so disable EVERY leg's button while any
  // reclaim runs (mirrors OrderRowItem) — otherwise idle legs look clickable but no-op.
  const anyBusy = reclaim.kind === "busy";
  // Resting legs of one post share a settle-by deadline; show it once, from the first open
  // leg. `now` is 0 until the first refresh stamps it — don't compute a bogus duration then.
  const openDeadline = legs.find(
    (l) => l.status === "open" && l.deadline != null,
  )?.deadline;
  const restsFor =
    anyOpen && openDeadline != null && now > 0
      ? relativeFuture(Number(openDeadline), now)
      : null;
  const windowClosed =
    anyOpen && openDeadline != null && now > 0 ? Number(openDeadline) <= now : false;

  return (
    <li className="k-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-medium text-ink">
            {formatUnits(totalIn, head.inDecimals)} {head.inTicker} → {head.outTicker}
            <span
              className="k-chip k-chip-accent cursor-help"
              tabIndex={0}
              title={`Pip split this swap across ${legs.length} pools (shards) in one drop-off, so more of it can fill. Each leg rests and settles on its own, at its own floor.`}
              aria-label={`Routed across ${legs.length} pools`}
            >
              routed across {legs.length} pools
            </span>
            {anyPartial && (
              <span
                className="k-chip k-chip-muted"
                title="Partial fills allowed. A partly-filled leg leaves a separate, reclaimable remainder order with the unfilled amount."
              >
                partial ok
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted">
            <a
              href={explorerTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
              title="View this split swap’s transaction on Cardanoscan"
              className="underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              {truncate(txHash, 10, 4)} ↗
            </a>{" "}
            · combined floor {formatUnits(floor, head.outDecimals)} {head.outTicker}
          </div>
        </div>
      </div>

      {/* Each leg, honestly: its own share, status, and per-order grab back. */}
      <ul className="mt-3 space-y-2 border-t border-border pt-3">
        {legs.map((leg, i) => {
          const busy = anyBusy && reclaim.ref === leg.ref;
          const legError =
            reclaim.kind === "error" && reclaim.ref === leg.ref
              ? reclaim.message
              : undefined;
          const reclaimDisabled =
            busy || anyBusy || !networkReady || !collateralReady;
          return (
            <li key={leg.ref}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-xs">
                  <span className="font-medium text-ink">Leg {i + 1}</span>
                  <span className="text-muted">
                    {" · "}
                    {formatUnits(leg.amountIn, leg.inDecimals)} {leg.inTicker} · floor{" "}
                    {formatUnits(leg.minOut, leg.outDecimals)} {leg.outTicker}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusChip status={leg.status} />
                  {leg.canReclaim && (
                    <button
                      type="button"
                      onClick={() => onReclaim(leg)}
                      disabled={reclaimDisabled}
                      title={baseReason ?? undefined}
                      className="k-btn-ghost px-3 py-1.5 text-xs"
                    >
                      {busy ? "Grabbing back…" : (baseReason ?? "Grab back")}
                    </button>
                  )}
                </div>
              </div>
              {leg.reclaimTx && (
                <div className="mt-1 text-[11px] text-success">
                  Grabbed back ✓. Your input, ADA deposit and tip are home in your
                  wallet.{" "}
                  <a
                    href={explorerTxUrl(leg.reclaimTx)}
                    target="_blank"
                    rel="noreferrer"
                    title="View the reclaim transaction on Cardanoscan"
                    className="font-mono underline decoration-dotted underline-offset-2"
                  >
                    {truncate(leg.reclaimTx, 10, 8)} ↗
                  </a>
                </div>
              )}
              {legError && (
                <div className="mt-1 flex items-center gap-1.5 break-words text-[11px] text-danger">
                  <Pip size={16} mood="calm" still />
                  <span>{legError}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Calm, static "still here, on purpose" signal — at group scope when any leg rests. */}
      {anyOpen && (
        <div className="mt-2 text-[11px] text-muted">
          {windowClosed
            ? "Their settle window has closed. Still resting, and yours to grab back anytime."
            : restsFor
              ? `Resting in the next batch · snug for ${restsFor} more`
              : "Resting in the next batch · grab any leg back anytime"}
        </div>
      )}
      {anyReclaimable && (
        <div className="mt-1 text-[11px] text-muted">
          Grabbing a leg back returns its input, ADA deposit and tip to your wallet.
        </div>
      )}
    </li>
  );
}

function OrderRowItem({
  row,
  now,
  busy,
  anyBusy,
  error,
  baseReason,
  networkReady,
  collateralReady,
  onReclaim,
}: {
  row: OrderRow;
  now: number;
  busy: boolean;
  anyBusy: boolean;
  error?: string;
  baseReason: string | null;
  networkReady: boolean;
  collateralReady: boolean;
  onReclaim: () => void;
}) {
  // Reclaim is a script spend: gate it like every other write flow (shared baseReason)
  // and say WHY on the button itself, rather than letting it fail at signing. The row
  // only renders while connected, so baseReason's "Connect wallet" branch never shows.
  const reclaimReason = baseReason;
  // Reclaims are serialized (one global in-flight latch), so disable EVERY row's button
  // while any reclaim is running — otherwise other rows look clickable but silently no-op.
  const reclaimDisabled = busy || anyBusy || !networkReady || !collateralReady;
  // Resting orders carry a settle-by deadline: a finite, cozy wait. `null` once it's past
  // (or when there's no deadline / it isn't a resting row) — and a passed deadline is a
  // calm, honest "window closed" note, never an alarm (the order still rests, reclaimable).
  // `now` is 0 until the first refresh stamps it; don't compute a bogus duration in that beat.
  const hasDeadline = row.deadline !== null && row.deadline !== undefined;
  const restsFor =
    row.status === "open" && hasDeadline && now > 0
      ? relativeFuture(Number(row.deadline), now)
      : null;
  const windowClosed =
    row.status === "open" && hasDeadline && now > 0 ? Number(row.deadline) <= now : false;
  return (
    <li className="k-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium text-ink">
            {formatUnits(row.amountIn, row.inDecimals)} {row.inTicker} →{" "}
            {row.outTicker}
            {row.partial && (
              <span
                className="k-chip k-chip-muted"
                title="Partial fills allowed. A partly-filled order leaves a separate, reclaimable remainder order with the unfilled amount."
              >
                partial ok
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted">
            <a
              href={explorerTxUrl(row.ref.split("#")[0])}
              target="_blank"
              rel="noreferrer"
              title="View this order’s transaction on Cardanoscan"
              className="underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              {truncate(row.ref, 10, 4)} ↗
            </a>{" "}
            · floor {formatUnits(row.minOut, row.outDecimals)} {row.outTicker}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip status={row.status} />
          {row.canReclaim && (
            <button
              type="button"
              onClick={onReclaim}
              disabled={reclaimDisabled}
              title={reclaimReason ?? undefined}
              className="k-btn-ghost px-3 py-1.5 text-xs"
            >
              {busy ? "Grabbing back…" : (reclaimReason ?? "Grab back")}
            </button>
          )}
        </div>
      </div>

      {/* A calm, static "still here, on purpose" signal for a resting order — works without
          motion (so reduced-motion + screen-reader users get the same reassurance). */}
      {row.status === "open" && (
        <div className="mt-1.5 text-[11px] text-muted">
          {windowClosed
            ? "Its settle window has closed. Still resting, and yours to grab back anytime."
            : restsFor
              ? `Resting in the next batch · snug for ${restsFor} more`
              : "Resting in the next batch · grab it back anytime"}
        </div>
      )}

      {row.canReclaim && (
        <div className="mt-1 text-[11px] text-muted">
          Grabbing it back returns your input, ADA deposit and tip to your wallet.
        </div>
      )}

      {row.reclaimTx && (
        <div className="mt-2 text-xs text-success">
          Grabbed back ✓. Your input, ADA deposit and tip are home in your
          wallet.{" "}
          <a
            href={explorerTxUrl(row.reclaimTx)}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2"
          >
            {truncate(row.reclaimTx, 10, 8)} ↗
          </a>
        </div>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-1.5 break-words text-xs text-danger">
          <Pip size={18} mood="calm" still />
          <span>{error}</span>
        </div>
      )}
    </li>
  );
}
