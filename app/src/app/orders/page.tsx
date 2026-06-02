"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";
import type { WalletPosition } from "@/lib/data";
import { useOrders } from "@/hooks/useOrders";
import { reclaimOrder } from "@/lib/client/tx";
import { toUserMessage } from "@/lib/client/errors";
import { explorerTxUrl } from "@/lib/config";
import { formatUnits, truncate } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent/15 text-accent",
  settled: "bg-white/10 text-muted",
  reclaimable: "bg-amber-500/15 text-amber-300",
};

type ReclaimState =
  | { kind: "idle" }
  | { kind: "busy"; ref: string }
  | { kind: "done"; ref: string; hash: string }
  | { kind: "error"; ref: string; message: string };

export default function OrdersPage() {
  const { connected, wallet } = useWallet();
  // Query by the wallet's CHANGE address — that is the payment key hash an order is
  // posted under (`postOrder` uses getChangeAddress), so it matches the order owner.
  // `useAddress()` (first used address) can differ on HD wallets that rotate
  // addresses, which would hide the user's own freshly-posted order. We only set
  // state from the async callback (never synchronously in the effect) and derive the
  // disconnected case, so there are no cascading renders.
  const [changeAddr, setChangeAddr] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    wallet
      .getChangeAddress()
      .then((a) => {
        if (!cancelled) setChangeAddr(a);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);
  const owner = connected ? changeAddr : undefined;
  const { orders, loading, error, reload } = useOrders(owner);
  const [reclaim, setReclaim] = useState<ReclaimState>({ kind: "idle" });

  async function onReclaim(ref: string) {
    setReclaim({ kind: "busy", ref });
    try {
      const hash = await reclaimOrder(wallet, ref);
      setReclaim({ kind: "done", ref, hash });
      reload();
    } catch (e) {
      setReclaim({ kind: "error", ref, message: toUserMessage(e) });
    }
  }

  // Also show the loading skeleton while the change address is still resolving, so
  // there's no "No live orders" flash before the first fetch can even start.
  const showLoading = loading || (connected && owner === undefined);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="mt-1 text-sm text-muted">
          Your live orders on preprod, read through the data-access layer. Reclaim
          any of them at any time — every order is owner-reclaimable.
        </p>
      </header>

      {!connected && <Empty>Connect a wallet to view your orders.</Empty>}

      {connected && error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          Failed to load orders: {error}
        </div>
      )}

      {connected && showLoading && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-white/5 bg-white/5"
            />
          ))}
        </div>
      )}

      {connected && !showLoading && !error && orders.length === 0 && (
        <Empty>No live orders. Post one from the Swap page.</Empty>
      )}

      {connected && !showLoading && orders.length > 0 && (
        <ul className="space-y-2">
          {orders.map((o) => (
            <OrderRow
              key={o.ref}
              order={o}
              reclaim={reclaim}
              onReclaim={() => onReclaim(o.ref)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderRow({
  order: o,
  reclaim,
  onReclaim,
}: {
  order: WalletPosition;
  reclaim: ReclaimState;
  onReclaim: () => void;
}) {
  const busy = reclaim.kind === "busy" && reclaim.ref === o.ref;
  const done = reclaim.kind === "done" && reclaim.ref === o.ref;
  const failed = reclaim.kind === "error" && reclaim.ref === o.ref;

  return (
    <li className="rounded-xl border border-white/10 bg-surface/60 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {formatUnits(o.amountIn, o.tokenIn.decimals)} {o.tokenIn.ticker} →{" "}
            {o.tokenOut.ticker}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted">
            {truncate(o.ref, 10, 4)} · min{" "}
            {formatUnits(o.minOut, o.tokenOut.decimals)} {o.tokenOut.ticker}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              STATUS_STYLE[o.status] ?? "bg-white/10 text-muted"
            }`}
          >
            {o.status}
          </span>
          <button
            type="button"
            onClick={onReclaim}
            disabled={busy}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Reclaiming…" : "Reclaim"}
          </button>
        </div>
      </div>

      {done && (
        <div className="mt-2 text-xs text-accent">
          Reclaimed ✓{" "}
          <a
            href={explorerTxUrl(reclaim.hash)}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2"
          >
            {truncate(reclaim.hash, 10, 8)} ↗
          </a>
        </div>
      )}
      {failed && (
        <div className="mt-2 break-words text-xs text-red-300">
          {reclaim.message}
        </div>
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
