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
 * How long a just-submitted reclaim is trusted optimistically before we verify it actually
 * confirmed on-chain. A simple reclaim spend confirms within ~one block, and a mempool race
 * against a settlement resolves in a block or two — but the clear is also liveness-gated
 * (only when the order has left the live set), so this window mainly bounds how long a
 * lost-race reclaim shows a false "reclaimed ✓" before the passive re-arm self-corrects it.
 * 5 min is comfortably past confirmation + Blockfrost indexer lag while still tidying up
 * promptly. A genuinely-successful reclaim is never cleared (its order leaves the live set
 * only once its own tx is indexed, so the verify sees it confirmed).
 */
const RECLAIM_VERIFY_GRACE_MS = 5 * 60 * 1000;

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

  // A locally-recorded reclaim is only TRUE once its tx confirms on-chain. A reclaim and a
  // solver settlement both spend the order UTXO, so a reclaim can lose a mempool race
  // (double-spend) and never land — leaving the row falsely showing "reclaimed ✓ / funds
  // back". This pass verifies any optimistic reclaim past the grace window and clears the
  // stale ones, with three rules that keep it honest AND safe:
  //
  //   • Clear ONLY when the tx is unconfirmed AND the order has LEFT the live set — the
  //     genuine lost-race signal (a settlement spent the order). If the order is still
  //     live, the reclaim is merely pending in the mempool: keep it optimistic rather than
  //     flip the row back to a clickable "open" that invites a doomed second reclaim.
  //     (Blockfrost only drops the order from the live set once it has indexed the spending
  //     block, at which point a WINNING reclaim's own tx is queryable too — so liveness
  //     gating also stops us from clearing a genuine reclaim during indexer lag.)
  //   • Anchor the grace window on `reclaimTs ?? ts` so a legacy entry recorded before this
  //     code shipped (no reclaimTs) is still eligible — not stuck "reclaimed" for 24h.
  //   • Re-arm a single one-shot timer at the soonest not-yet-due grace boundary, so an
  //     idle tab self-corrects without a manual Refresh — bounded (one timer per pending
  //     reclaim), not interval polling.
  //
  // Confirmed reclaims are cached in-session so we don't re-query them; a transient provider
  // error never clears. Deferred per the project's effect convention.
  const reclaimVerified = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ownerAddr) return;
    let cancelled = false;
    let rearm: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();

    const optimisticReclaims = () =>
      getRecent(ownerAddr, nowMs()).filter(
        (o) => o.reclaimTx !== undefined && !reclaimVerified.current.has(o.reclaimTx),
      );
    // A reclaim's grace window elapses this far in the future (≤0 ⇒ already due).
    const dueIn = (o: RecentOrder) =>
      (o.reclaimTs ?? o.ts) + RECLAIM_VERIFY_GRACE_MS - nowMs();

    const runVerify = async () => {
      if (cancelled) return;
      const due = optimisticReclaims().filter((o) => dueIn(o) <= 0);
      let changed = false;
      for (const o of due) {
        if (cancelled) return;
        try {
          if (await fetchTxConfirmed(o.reclaimTx!, ac.signal)) {
            reclaimVerified.current.add(o.reclaimTx!); // genuine reclaim — keep "reclaimed ✓"
          } else if (!orders.some((p) => p.ref === o.ref)) {
            // Unconfirmed AND the order is gone → it lost the race. Clear so the row reads
            // the honest "completed", never a false "reclaimed ✓".
            clearReclaim(ownerAddr, o.ref, nowMs());
            changed = true;
          }
          // else: unconfirmed but still live → pending in the mempool; keep optimistic.
        } catch {
          // transient provider error / aborted — keep the optimistic state, retry later
        }
      }
      if (changed && !cancelled) {
        setRecent(getRecent(ownerAddr, nowMs()));
        setNow(nowMs());
      }
      // Self-correct an idle tab: fire once when the soonest still-pending reclaim crosses
      // its grace window (a bounded one-shot, re-scheduled each pass — not a poll).
      if (!cancelled) {
        const waits = optimisticReclaims().map(dueIn).filter((ms) => ms > 0);
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
          <p className="mt-1 text-xs text-muted">
            <span className="text-accent">Open</span> = live & yours to grab back ·{" "}
            <span className="text-muted">Completed</span> = no longer live (settled or
            reclaimed — check the explorer to be sure).
          </p>
        </div>
        {connected && (
          <button
            type="button"
            onClick={refresh}
            className="k-btn-ghost shrink-0 px-3 py-1.5 text-xs"
          >
            Refresh
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
            {truncate(row.ref, 10, 4)} · min{" "}
            {formatUnits(row.minOut, row.outDecimals)} {row.outTicker}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`k-chip ${STATUS_STYLE[row.status]}`}
            title={STATUS_HELP[row.status]}
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
