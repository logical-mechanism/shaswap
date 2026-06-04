"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@meshsdk/react";
import { useOrders } from "@/hooks/useOrders";
import { useWriteGate } from "@/hooks/useWriteGate";
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
  mergeRows,
  type OrderRow,
  type RowStatus,
} from "@/lib/client/orderRows";
import { toUserMessage } from "@/lib/client/errors";
import { explorerTxUrl } from "@/lib/config";
import { formatUnits, truncate } from "@/lib/format";
import { Pip } from "@/components/Pip";
import { PipLoading } from "@/components/PipLoading";
import { CollateralNote } from "@/components/CollateralNote";

const STATUS_STYLE: Record<RowStatus, string> = {
  pending: "k-chip-warn",
  open: "k-chip-accent",
  completed: "k-chip-muted",
  reclaimed: "k-chip-success",
};

/** Honest, plain-language explanation of each row state (badge tooltip + legend). */
const STATUS_HELP: Record<RowStatus, string> = {
  pending: "Submitted — waiting to be confirmed on-chain.",
  open: "Live on-chain and reclaimable by you. A solver may settle it at the batch price.",
  completed:
    "No longer on-chain — settled by a solver, or reclaimed elsewhere. Confirm the outcome on the explorer.",
  reclaimed: "You reclaimed this order; the funds are back in your wallet.",
};

const STATUS_LABEL: Record<RowStatus, string> = {
  pending: "pending",
  open: "open",
  completed: "completed",
  reclaimed: "reclaimed",
};

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
  // Query by the wallet's CHANGE address — the payment key hash orders are posted
  // under (`postOrder` uses getChangeAddress) — so HD wallets that rotate addresses
  // still see their own orders, and the local activity log keys match.
  const [owner, setOwner] = useState<string | undefined>(undefined);
  const [ownerAttempted, setOwnerAttempted] = useState(false);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    wallet
      .getChangeAddress()
      .then((a) => {
        if (!cancelled) {
          setOwner(a);
          setOwnerAttempted(true);
        }
      })
      .catch(() => {
        // Don't hang on the loading skeleton forever — mark the attempt done so the
        // error state can render (the wallet errored / disconnected mid-call).
        if (!cancelled) setOwnerAttempted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);
  const ownerAddr = connected ? owner : undefined;
  const ownerError = connected && ownerAttempted && !ownerAddr;

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
            Everything you’ve dropped off, plus recent activity. While an order’s
            live, it’s always yours to grab back.
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
            {loading ? (
              <span className="flex items-center gap-1.5">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  className="animate-spin"
                  aria-hidden
                >
                  <path
                    d="M13.5 8a5.5 5.5 0 10-1.6 3.9M13.5 12.5V9h-3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Refreshing…
              </span>
            ) : (
              "Refresh"
            )}
          </button>
        )}
      </header>

      {connected && needsCollateral && (
        <CollateralNote onRecheck={recheckCollateral}>
          Reclaiming an order spends a script, so your wallet needs a collateral UTXO. Set
          one in your wallet, then re-check.
        </CollateralNote>
      )}

      {!connected && <Empty>Connect a wallet and Pip will round up your orders.</Empty>}

      {ownerError && (
        <div className="k-note k-note-danger flex items-center gap-2 p-4 text-sm">
          <Pip size={24} mood="worried" />
          <span>Pip couldn’t read your wallet address — reconnect and try again.</span>
        </div>
      )}

      {connected && error && (
        <div className="k-note k-note-danger p-4 text-sm">
          <div className="flex items-center gap-2">
            <Pip size={24} mood="worried" />
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
        <PipLoading label="Pip’s gathering your orders…" />
      )}

      {connected && !showLoading && !error && rows.length === 0 && (
        <Empty>No orders yet — drop one off from the Swap page.</Empty>
      )}

      {connected && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <OrderRowItem
              key={row.ref}
              row={row}
              busy={reclaim.kind === "busy" && reclaim.ref === row.ref}
              anyBusy={reclaim.kind === "busy"}
              error={
                reclaim.kind === "error" && reclaim.ref === row.ref
                  ? reclaim.message
                  : undefined
              }
              baseReason={baseReason}
              networkReady={networkReady}
              collateralReady={collateralReady}
              onReclaim={() => onReclaim(row)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderRowItem({
  row,
  busy,
  anyBusy,
  error,
  baseReason,
  networkReady,
  collateralReady,
  onReclaim,
}: {
  row: OrderRow;
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
                title="Partial fills allowed — a partly-filled order leaves a separate, reclaimable remainder order with the unfilled amount."
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
            · min {formatUnits(row.minOut, row.outDecimals)} {row.outTicker}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`k-chip ${STATUS_STYLE[row.status]} cursor-help`}
            tabIndex={0}
            title={STATUS_HELP[row.status]}
            aria-label={`${STATUS_LABEL[row.status]} — ${STATUS_HELP[row.status]}`}
          >
            {STATUS_LABEL[row.status]}
          </span>
          {row.canReclaim && (
            <button
              type="button"
              onClick={onReclaim}
              disabled={reclaimDisabled}
              title={reclaimReason ?? undefined}
              className="k-btn-ghost px-3 py-1.5 text-xs"
            >
              {busy ? "Reclaiming…" : (reclaimReason ?? "Reclaim")}
            </button>
          )}
        </div>
      </div>

      {row.canReclaim && (
        <div className="mt-1.5 text-[11px] text-muted">
          Reclaim returns your input plus the order’s min-ADA and tip to your wallet.
        </div>
      )}

      {row.reclaimTx && (
        <div className="mt-2 text-xs text-success">
          Reclaimed ✓ — your input, min-ADA and tip are back in your wallet.{" "}
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
          <Pip size={18} mood="worried" />
          <span>{error}</span>
        </div>
      )}
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="k-card px-4 py-12 text-center text-sm text-muted">
      <Pip size={56} mood="sleepy" className="mb-3" />
      <div>{children}</div>
    </div>
  );
}
