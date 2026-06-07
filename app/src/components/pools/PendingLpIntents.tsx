"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/hooks";
import type { Pool } from "@/lib/data";
import { useLpIntents } from "@/hooks/useLpIntents";
import { useWriteGate } from "@/hooks/useWriteGate";
import { fetchTxConfirmed } from "@/lib/client/api";
import { nowMs } from "@/lib/client/now";
import {
  clearLpReclaim,
  getRecentLpIntents,
  markLpSeen,
  type RecentLpIntent,
} from "@/lib/client/lpIntentActivity";
import {
  mergeLpIntentRows,
  type LpIntentRow,
  type RowStatus,
} from "@/lib/client/lpIntentRows";
import { toUserMessage } from "@/lib/client/errors";
import { explorerTxUrl } from "@/lib/config";
import { formatUnits, truncate } from "@/lib/format";
import { Pip } from "@/components/Pip";
import { CollateralNote } from "@/components/CollateralNote";

/**
 * The per-pool LP-intent surface — a sibling of the Orders page, scoped to one pool: shows
 * this wallet's pending → open → completed/reclaimed intents (merged on-chain + local log) and
 * lets the owner reclaim a live one. UX honesty: a withdraw reclaim returns the LP tokens, NOT
 * the underlying (the §13 residual). Reloads whenever `refreshKey` changes (e.g. after a post).
 */

const STATUS_STYLE: Record<RowStatus, string> = {
  pending: "k-chip-warn",
  open: "k-chip-accent",
  completed: "k-chip-muted",
  reclaimed: "k-chip-success",
};

const STATUS_HELP: Record<RowStatus, string> = {
  pending: "Submitted, waiting to be confirmed on-chain.",
  open: "Live on-chain. A batcher may fulfil it, or you can reclaim it anytime.",
  completed:
    "No longer on-chain. Fulfilled by a batcher, or reclaimed elsewhere. Confirm on the explorer.",
  reclaimed: "You reclaimed this intent; the locked value is back in your wallet.",
};

/** Grace before reconciling a logged entry against the chain (past confirmation + indexer lag). */
const RECONCILE_GRACE_MS = 5 * 60 * 1000;

type ReclaimState =
  | { kind: "idle" }
  | { kind: "busy"; ref: string }
  | { kind: "error"; ref: string; message: string };

export function PendingLpIntents({
  pool,
  refreshKey,
}: {
  pool: Pool;
  refreshKey: number;
}) {
  const { connected, wallet } = useWallet();
  const { networkReady, collateralReady, needsCollateral, recheckCollateral, baseReason } =
    useWriteGate({ requireCollateral: true });

  // Owner = the wallet's CHANGE address (the key intents are posted + logged under), resolved
  // in the async callback only (the project's effect convention — never set synchronously in an
  // effect body). On disconnect we DERIVE `ownerAddr` as undefined rather than resetting state,
  // mirroring the Orders page, so a stale value can't leak through.
  const [owner, setOwner] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    wallet
      .getChangeAddress()
      .then((a) => {
        if (!cancelled) setOwner(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);
  const ownerAddr = connected ? owner : undefined;

  const { intents, loading, reload } = useLpIntents(ownerAddr);
  const [recent, setRecent] = useState<RecentLpIntent[]>([]);
  const [now, setNow] = useState(0);
  const [reclaim, setReclaim] = useState<ReclaimState>({ kind: "idle" });
  const reclaiming = useRef(false);

  // Filter both sides to THIS pool (the panel is per-pool).
  const liveForPool = intents.filter((i) => i.poolNft === pool.id);

  const refresh = useCallback(() => {
    reload();
    setRecent(
      ownerAddr ? getRecentLpIntents(ownerAddr, nowMs()).filter((r) => r.poolNft === pool.id) : [],
    );
    setNow(nowMs());
    setReclaim({ kind: "idle" });
  }, [ownerAddr, pool.id, reload]);

  // Re-read the local log on owner change, on a post (refreshKey), and on mount.
  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, [refresh, refreshKey]);

  // Stamp live intents as positively observed, so a fulfilled/reclaimed one later reads
  // "completed" rather than bouncing back to "pending".
  useEffect(() => {
    if (!ownerAddr || liveForPool.length === 0) return;
    const id = setTimeout(() => {
      markLpSeen(ownerAddr, liveForPool.map((o) => o.ref), nowMs());
      setRecent(getRecentLpIntents(ownerAddr, nowMs()).filter((r) => r.poolNft === pool.id));
      setNow(nowMs());
    }, 0);
    return () => clearTimeout(id);
  }, [ownerAddr, pool.id, intents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile an optimistic reclaim once its grace window elapses: keep "reclaimed" only if the
  // reclaim tx confirmed; if it's gone from the live set but unconfirmed, it lost a race → clear
  // to the honest on-chain status. Single pass on each refresh (transient errors leave it).
  const reclaimVerified = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ownerAddr) return;
    let cancelled = false;
    const ac = new AbortController();
    const isLive = (ref: string) => liveForPool.some((p) => p.ref === ref);
    const id = setTimeout(async () => {
      let changed = false;
      for (const r of recent) {
        if (cancelled) return;
        if (r.reclaimTx === undefined || reclaimVerified.current.has(r.reclaimTx)) continue;
        if ((r.reclaimTs ?? r.ts) + RECONCILE_GRACE_MS - nowMs() > 0) continue;
        try {
          if (await fetchTxConfirmed(r.reclaimTx, ac.signal)) {
            reclaimVerified.current.add(r.reclaimTx);
          } else if (!isLive(r.ref)) {
            clearLpReclaim(ownerAddr, r.ref, nowMs());
            changed = true;
          }
        } catch {
          // transient — leave as-is, retry next refresh
        }
      }
      if (changed && !cancelled) {
        setRecent(getRecentLpIntents(ownerAddr, nowMs()).filter((x) => x.poolNft === pool.id));
        setNow(nowMs());
      }
    }, 0);
    return () => {
      cancelled = true;
      ac.abort();
      clearTimeout(id);
    };
  }, [ownerAddr, pool.id, recent, intents]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = ownerAddr ? mergeLpIntentRows(liveForPool, recent, now) : [];

  async function onReclaim(row: LpIntentRow) {
    if (reclaiming.current || !ownerAddr) return;
    reclaiming.current = true;
    setReclaim({ kind: "busy", ref: row.ref });
    try {
      const { reclaimLpIntent } = await import("@/lib/client/tx");
      const hash = await reclaimLpIntent(wallet, row.ref);
      const { recordLpIntent } = await import("@/lib/client/lpIntentActivity");
      // Upsert a reclaimed entry (dedups by ref) so the row shows "reclaimed" and isn't offered
      // for a doomed second reclaim, even for an intent not previously in the local log.
      recordLpIntent(ownerAddr, {
        ref: row.ref,
        txHash: row.ref.split("#")[0],
        poolNft: pool.id,
        action: row.action,
        aTicker: row.aTicker,
        aDecimals: row.aDecimals,
        bTicker: row.bTicker,
        bDecimals: row.bDecimals,
        lp: row.lp,
        depositA: row.depositA,
        depositB: row.depositB,
        tip: row.tip,
        ts: nowMs(),
        seenLive: nowMs(),
        reclaimTx: hash,
        reclaimTs: nowMs(),
      });
      setReclaim({ kind: "idle" });
      refresh();
    } catch (e) {
      setReclaim({ kind: "error", ref: row.ref, message: toUserMessage(e) });
    } finally {
      reclaiming.current = false;
    }
  }

  if (!connected || (rows.length === 0 && !loading)) return null;

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Pip size={20} mood="happy" />
        <span className="text-sm font-bold text-ink">Your LP intents here</span>
      </div>

      {needsCollateral && rows.some((r) => r.canReclaim) && (
        <CollateralNote onRecheck={recheckCollateral}>
          Reclaiming needs a collateral set in your wallet. Add one, then re-check.
        </CollateralNote>
      )}

      <ul className="space-y-2">
        {rows.map((row) => (
          <IntentRowItem
            key={row.ref}
            row={row}
            busy={reclaim.kind === "busy" && reclaim.ref === row.ref}
            anyBusy={reclaim.kind === "busy"}
            error={reclaim.kind === "error" && reclaim.ref === row.ref ? reclaim.message : undefined}
            baseReason={baseReason}
            networkReady={networkReady}
            collateralReady={collateralReady}
            onReclaim={() => onReclaim(row)}
          />
        ))}
      </ul>
    </div>
  );
}

function IntentRowItem({
  row,
  busy,
  anyBusy,
  error,
  baseReason,
  networkReady,
  collateralReady,
  onReclaim,
}: {
  row: LpIntentRow;
  busy: boolean;
  anyBusy: boolean;
  error?: string;
  baseReason: string | null;
  networkReady: boolean;
  collateralReady: boolean;
  onReclaim: () => void;
}) {
  const reclaimDisabled = busy || anyBusy || !networkReady || !collateralReady;
  const summary =
    row.action === "withdraw"
      ? `Withdraw ${Number(row.lp ?? "0").toLocaleString()} LP`
      : `Deposit ${formatUnits(row.depositA, row.aDecimals)} ${row.aTicker} + ${formatUnits(
          row.depositB,
          row.bDecimals,
        )} ${row.bTicker}`;

  return (
    <li className="k-card p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">{summary}</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted">
            <a
              href={explorerTxUrl(row.ref.split("#")[0])}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              {truncate(row.ref, 8, 4)} ↗
            </a>{" "}
            · tip {formatUnits(row.tip, 6)} ₳
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`k-chip ${STATUS_STYLE[row.status]} cursor-help`}
            tabIndex={0}
            title={STATUS_HELP[row.status]}
            aria-label={`${row.status}: ${STATUS_HELP[row.status]}`}
          >
            {row.status}
          </span>
          {row.canReclaim && (
            <button
              type="button"
              onClick={onReclaim}
              disabled={reclaimDisabled}
              title={baseReason ?? undefined}
              className="k-btn-ghost px-3 py-1.5 text-xs"
            >
              {busy ? "Reclaiming…" : (baseReason ?? "Reclaim")}
            </button>
          )}
        </div>
      </div>

      {row.canReclaim && (
        <div className="mt-1.5 text-[11px] text-muted">
          {row.action === "withdraw"
            ? "Reclaim returns your LP tokens (not the underlying) plus the min-ADA and tip."
            : "Reclaim returns the deposited tokens plus the min-ADA and tip to your wallet."}
        </div>
      )}

      {row.reclaimTx && (
        <div className="mt-2 text-xs text-success">
          Reclaimed ✓.{" "}
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
          <Pip size={16} mood="worried" />
          <span>{error}</span>
        </div>
      )}
    </li>
  );
}
