"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNetwork, useWallet } from "@meshsdk/react";
import { useOrders } from "@/hooks/useOrders";
import { useWalletCollateral } from "@/hooks/useWalletCollateral";
import { reclaimOrder } from "@/lib/client/tx";
import {
  getRecent,
  markSeen,
  recordPost,
  type RecentOrder,
} from "@/lib/client/activity";
import { nowMs } from "@/lib/client/now";
import {
  hasPending,
  mergeRows,
  type OrderRow,
  type RowStatus,
} from "@/lib/client/orderRows";
import { toUserMessage } from "@/lib/client/errors";
import { APP_CONFIG, explorerTxUrl, networkLabel } from "@/lib/config";
import { formatUnits, truncate } from "@/lib/format";

const STATUS_STYLE: Record<RowStatus, string> = {
  pending: "bg-amber-500/15 text-amber-300",
  open: "bg-accent/15 text-accent",
  completed: "bg-white/10 text-muted",
  reclaimed: "bg-emerald-500/15 text-emerald-300",
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

type ReclaimState =
  | { kind: "idle" }
  | { kind: "busy"; ref: string }
  | { kind: "error"; ref: string; message: string };

export default function OrdersPage() {
  const { connected, wallet } = useWallet();
  const networkId = useNetwork();
  const { hasCollateral, loading: collateralLoading } = useWalletCollateral();
  // Reclaim spends a script UTXO, so it carries the same gates as every other write
  // flow: correct network + a collateral UTXO. (It was the only flow missing them.)
  const wrongNetwork =
    connected && networkId !== undefined && networkId !== APP_CONFIG.networkId;
  const networkReady = connected && networkId === APP_CONFIG.networkId;
  const collateralReady = hasCollateral || collateralLoading;
  const needsCollateral = connected && !hasCollateral && !collateralLoading;
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

  // Re-read the local activity log + refetch the live set. Only ever sets state from
  // here (a callback), never synchronously in an effect body. Also clears any stale
  // reclaim error so it isn't sticky across a refresh / poll / status change.
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

  // Whenever the live set resolves, stamp each live order as positively observed
  // on-chain (seenLive), then re-read the log. This keeps a just-posted order "pending"
  // (and auto-refreshing) through indexer lag, and makes a LATER disappearance the only
  // terminal signal — instead of a fixed timer guessing "settled". Deferred per the
  // project's effect convention.
  useEffect(() => {
    if (!ownerAddr || orders.length === 0) return;
    const id = setTimeout(() => {
      markSeen(ownerAddr, orders.map((o) => o.ref), nowMs());
      setRecent(getRecent(ownerAddr, nowMs()));
      setNow(nowMs());
    }, 0);
    return () => clearTimeout(id);
  }, [ownerAddr, orders]);

  const rows = useMemo(
    () => (ownerAddr ? mergeRows(orders, recent, now) : []),
    [ownerAddr, orders, recent, now],
  );
  const pending = hasPending(rows);

  // Auto-refresh while something is pending confirmation (stops once it lands).
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [pending, refresh]);

  async function onReclaim(row: OrderRow) {
    setReclaim({ kind: "busy", ref: row.ref });
    try {
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
          reclaimTx: hash,
        });
      }
      setReclaim({ kind: "idle" });
      refresh();
    } catch (e) {
      setReclaim({ kind: "error", ref: row.ref, message: toUserMessage(e) });
    }
  }

  const showLoading =
    loading || (connected && ownerAddr === undefined && !ownerError);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="mt-1 text-sm text-muted">
            Your live orders on {networkLabel()} plus recent activity. Every order is
            owner-reclaimable while it’s live.
          </p>
          <p className="mt-1 text-xs text-muted/70">
            <span className="text-accent">Open</span> = live & reclaimable ·{" "}
            <span className="text-muted">Completed</span> = no longer on-chain (settled or
            reclaimed — confirm on the explorer).
          </p>
        </div>
        {connected && (
          <button
            type="button"
            onClick={refresh}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
          >
            Refresh
          </button>
        )}
      </header>

      {!connected && <Empty>Connect a wallet to view your orders.</Empty>}

      {ownerError && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          Couldn’t read your wallet address. Reconnect the wallet and try again.
        </div>
      )}

      {connected && error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          <div>Couldn’t load your orders. {error}</div>
          <button
            type="button"
            onClick={refresh}
            className="mt-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/10"
          >
            Retry
          </button>
        </div>
      )}

      {connected && showLoading && rows.length === 0 && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-white/5 bg-white/5"
            />
          ))}
        </div>
      )}

      {connected && !showLoading && !error && rows.length === 0 && (
        <Empty>No orders yet. Post one from the Swap page.</Empty>
      )}

      {connected && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <OrderRowItem
              key={row.ref}
              row={row}
              busy={reclaim.kind === "busy" && reclaim.ref === row.ref}
              error={
                reclaim.kind === "error" && reclaim.ref === row.ref
                  ? reclaim.message
                  : undefined
              }
              wrongNetwork={!!wrongNetwork}
              networkReady={networkReady}
              needsCollateral={needsCollateral}
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
  error,
  wrongNetwork,
  networkReady,
  needsCollateral,
  collateralReady,
  onReclaim,
}: {
  row: OrderRow;
  busy: boolean;
  error?: string;
  wrongNetwork: boolean;
  networkReady: boolean;
  needsCollateral: boolean;
  collateralReady: boolean;
  onReclaim: () => void;
}) {
  // Reclaim is a script spend: gate it like every other write flow and say WHY on the
  // button itself, rather than letting it fail at signing.
  const reclaimReason = wrongNetwork
    ? "Wrong network"
    : !networkReady
      ? "Checking network…"
      : needsCollateral
        ? "Needs collateral"
        : null;
  const reclaimDisabled = busy || !networkReady || !collateralReady;
  return (
    <li className="rounded-xl border border-white/10 bg-surface/60 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            {formatUnits(row.amountIn, row.inDecimals)} {row.inTicker} →{" "}
            {row.outTicker}
            {row.partial && (
              <span
                className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-normal text-muted"
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
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[row.status]}`}
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
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Reclaiming…" : (reclaimReason ?? "Reclaim")}
            </button>
          )}
        </div>
      </div>

      {row.canReclaim && (
        <div className="mt-1.5 text-[11px] text-muted/70">
          Reclaim returns your input plus the order’s min-ADA and tip to your wallet.
        </div>
      )}

      {row.reclaimTx && (
        <div className="mt-2 text-xs text-emerald-300">
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
        <div className="mt-2 break-words text-xs text-red-300">{error}</div>
      )}
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-surface/40 px-4 py-12 text-center text-sm text-muted">
      {children}
    </div>
  );
}
