"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWallet, useLovelace, useAssets } from "@/lib/wallet/hooks";
import { useOwnerAddress } from "@/hooks/useOwnerAddress";
import { useOrders } from "@/hooks/useOrders";
import { useLpIntents } from "@/hooks/useLpIntents";
import { useTokens } from "@/hooks/useTokens";
import { mergeRows } from "@/lib/client/orderRows";
import { mergeLpIntentRows } from "@/lib/client/lpIntentRows";
import { getRecent, type RecentOrder } from "@/lib/client/activity";
import { getRecentLpIntents, type RecentLpIntent } from "@/lib/client/lpIntentActivity";
import { nowMs } from "@/lib/client/now";
import { countResting, summarizeWalletTokens } from "@/lib/client/portfolio";
import { formatAda } from "@/lib/format";
import { Pip } from "@/components/Pip";
import { PipLoading } from "@/components/PipLoading";
import { PipEmptyState } from "@/components/PipEmptyState";
import { RefreshIcon } from "@/components/RefreshIcon";

/**
 * Portfolio — a single, at-a-glance "where's my capital" view for the connected wallet:
 * resting orders, liquidity moves in flight, and what's in the wallet, each linking into its
 * detail page. Pure aggregation over the existing read-only hooks — no new data source, and
 * (like the Orders page) NO polling: the live sets refresh on demand only.
 */
export default function PortfolioPage() {
  const { connected, refresh: refreshWallet } = useWallet();
  const { ownerAddr, ownerError } = useOwnerAddress();
  const lovelace = useLovelace();
  const assets = useAssets();

  const {
    orders,
    loading: ordersLoading,
    error: ordersError,
    reload: reloadOrders,
  } = useOrders(ownerAddr);
  const {
    intents,
    loading: intentsLoading,
    error: intentsError,
    reload: reloadIntents,
  } = useLpIntents(ownerAddr);
  const { tokens, loading: tokensLoading, error: tokensError } = useTokens();

  // The local activity logs let the resting counts match the detail pages exactly — a live
  // order/intent we've already grabbed back locally (still on-chain through indexer lag) is
  // dropped from the "open" count, just as /orders and /pools drop it from their lists.
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [recentLp, setRecentLp] = useState<RecentLpIntent[]>([]);
  const [now, setNow] = useState(0);

  // Re-read the live sets + the local activity logs + the wallet balance. On-demand only
  // (mirrors the Orders page) — NO polling timer. State is only written from this callback,
  // never synchronously in an effect body (the project's effect convention).
  const refresh = useCallback(() => {
    reloadOrders();
    reloadIntents();
    refreshWallet();
    setRecentOrders(ownerAddr ? getRecent(ownerAddr, nowMs()) : []);
    setRecentLp(ownerAddr ? getRecentLpIntents(ownerAddr, nowMs()) : []);
    setNow(nowMs());
  }, [ownerAddr, reloadOrders, reloadIntents, refreshWallet]);

  // Initial load once the owner resolves (deferred out of the effect body, per convention).
  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, [refresh]);

  const restingOrders = useMemo(
    () => (ownerAddr ? countResting(mergeRows(orders, recentOrders, now)) : 0),
    [ownerAddr, orders, recentOrders, now],
  );
  const liquidityMoves = useMemo(
    () => (ownerAddr ? countResting(mergeLpIntentRows(intents, recentLp, now)) : 0),
    [ownerAddr, intents, recentLp, now],
  );
  const walletTokens = useMemo(
    () => summarizeWalletTokens(assets, tokens),
    [assets, tokens],
  );

  // The wallet's token line degrades honestly: counting while the registry loads, "showing
  // ADA only" if it couldn't be read, else the recognised-token tally (a few tickers inline).
  // When nothing's recognised we only say "just ADA" if there's GENUINELY nothing else — any
  // unrecognised tokens / NFTs are owned up to rather than papered over.
  const walletSummary = tokensLoading
    ? "Counting what else you’re holding…"
    : tokensError
      ? "Showing ADA — Pip couldn’t reach the token list."
      : walletTokens.count > 0
        ? `+ ${walletTokens.count === 1 ? "1 token" : `${walletTokens.count} tokens`}: ${walletTokens.tickers
            .slice(0, 3)
            .join(", ")}${walletTokens.count > 3 ? "…" : ""}`
        : walletTokens.otherCount > 0
          ? `Plus ${walletTokens.otherCount} ${
              walletTokens.otherCount === 1 ? "thing" : "things"
            } Pip doesn’t recognise.`
          : "Nothing else in here for now.";

  const showLoading = connected && ownerAddr === undefined && !ownerError;
  const anyLoading = ordersLoading || intentsLoading || tokensLoading;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Pip size={30} mood="happy" />
            <h1 className="font-display text-2xl font-extrabold text-ink">Your corner</h1>
          </div>
          <p className="mt-1 text-sm text-muted">
            Everything Pip’s keeping an eye on — what’s resting, what’s in flight, and what’s
            in your wallet.
          </p>
        </div>
        {connected && ownerAddr && (
          <button
            type="button"
            onClick={refresh}
            disabled={anyLoading}
            aria-busy={anyLoading}
            className="k-btn-ghost shrink-0 px-3 py-1.5 text-xs disabled:opacity-70"
          >
            <span className="flex items-center gap-1.5">
              <RefreshIcon busy={anyLoading} />
              {anyLoading ? "Refreshing…" : "Refresh"}
            </span>
          </button>
        )}
      </header>

      {!connected && (
        <PipEmptyState
          mood="wave"
          body="Connect a wallet and Pip will show you your corner of the market — what’s resting, what’s in flight, and what’s in your wallet."
        />
      )}

      {ownerError && (
        <div className="k-note k-note-danger flex items-center gap-2 p-4 text-sm">
          <Pip size={24} mood="calm" still />
          <span>Pip couldn’t read your wallet address. Reconnect and try again.</span>
        </div>
      )}

      {connected && showLoading && <PipLoading label="Pip’s gathering your things…" />}

      {connected && ownerAddr && (
        <div className="grid gap-4 sm:grid-cols-3">
          <SummaryCard
            icon={<Pip size={26} mood="sleepy" />}
            title="Resting orders"
            href="/orders"
            cta="View orders"
            loading={ordersLoading}
            error={ordersError}
            headline={String(restingOrders)}
            summary={
              restingOrders === 0
                ? "Nothing resting right now."
                : `${
                    restingOrders === 1 ? "One order is" : `${restingOrders} orders are`
                  } resting in the next batch.`
            }
          />
          <SummaryCard
            icon={<Pip size={26} mood="thinking" />}
            title="Liquidity moves"
            href="/pools"
            cta="Browse pools"
            loading={intentsLoading}
            error={intentsError}
            headline={String(liquidityMoves)}
            summary={
              liquidityMoves === 0
                ? "No deposits or withdrawals in flight."
                : `${
                    liquidityMoves === 1
                      ? "One liquidity move is"
                      : `${liquidityMoves} liquidity moves are`
                  } waiting in the gardens.`
            }
          />
          <SummaryCard
            icon={<Pip size={26} mood="happy" />}
            title="Wallet"
            href="/"
            cta="Swap"
            loading={lovelace === undefined}
            headline={`₳${formatAda(lovelace)}`}
            // The ₳ glyph (U+20B3) isn't reliably voiced — spell the unit for screen readers.
            spoken={`${formatAda(lovelace)} ADA`}
            headlineClassName="text-2xl"
            summary={walletSummary}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One summary card: an icon + title, a headline number/balance with a one-line summary, and a
 * "view all →" cue. The whole card is the link into its detail page (a big, mobile-friendly tap
 * target); its own loading/error state keeps a slow or failed source from blocking the others.
 */
function SummaryCard({
  icon,
  title,
  href,
  cta,
  headline,
  spoken,
  headlineClassName = "text-3xl",
  summary,
  loading = false,
  error,
}: {
  icon: ReactNode;
  title: string;
  href: string;
  cta: string;
  headline: string;
  /** A spoken form of the headline for the aria-label (defaults to the visible headline). */
  spoken?: string;
  headlineClassName?: string;
  summary: string;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <Link
      href={href}
      aria-label={`${title}: ${
        error ? "unavailable" : loading ? "loading" : (spoken ?? headline)
      }. ${cta}.`}
      className="k-card group flex flex-col p-5 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0">{icon}</span>
        <h2 className="font-display text-base font-extrabold text-ink">{title}</h2>
      </div>

      <div className="mt-3 flex-1">
        {loading ? (
          <div className="flex items-center gap-1.5 text-sm text-muted">
            <RefreshIcon busy />
            <span>Pip’s counting…</span>
          </div>
        ) : error ? (
          <div className="flex items-start gap-1.5 text-sm text-muted">
            <Pip size={18} mood="calm" still />
            <span>Pip couldn’t reach the chain just now — try Refresh.</span>
          </div>
        ) : (
          <>
            <div
              className={`font-display font-extrabold tabular-nums text-ink ${headlineClassName}`}
            >
              {headline}
            </div>
            <p className="mt-1 text-sm text-muted">{summary}</p>
          </>
        )}
      </div>

      <span
        aria-hidden
        className="mt-4 text-sm font-bold text-muted transition-colors group-hover:text-accent"
      >
        {cta} →
      </span>
    </Link>
  );
}
