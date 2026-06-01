"use client";

import { useAddress, useWallet } from "@meshsdk/react";
import { useOrders } from "@/hooks/useOrders";
import { formatUnits, truncate } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  open: "bg-accent/15 text-accent",
  settled: "bg-white/10 text-muted",
  reclaimable: "bg-amber-500/15 text-amber-300",
};

export default function OrdersPage() {
  const { connected } = useWallet();
  const address = useAddress();
  const { orders, loading, error } = useOrders(address);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="mt-1 text-sm text-muted">
          Your open orders and positions, read through the data-access layer
          (mock data).
        </p>
      </header>

      {!connected && (
        <Empty>Connect a wallet to view your orders.</Empty>
      )}

      {connected && error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          Failed to load orders: {error}
        </div>
      )}

      {connected && loading && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-xl border border-white/5 bg-white/5"
            />
          ))}
        </div>
      )}

      {connected && !loading && !error && orders.length === 0 && (
        <Empty>No orders yet.</Empty>
      )}

      {connected && !loading && orders.length > 0 && (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li
              key={o.ref}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-surface/60 px-4 py-3"
            >
              <div>
                <div className="font-medium">
                  {formatUnits(o.amountIn, o.tokenIn.decimals)}{" "}
                  {o.tokenIn.ticker} → {o.tokenOut.ticker}
                </div>
                <div className="mt-0.5 font-mono text-xs text-muted">
                  {truncate(o.ref, 10, 4)} · min{" "}
                  {formatUnits(o.minOut, o.tokenOut.decimals)}{" "}
                  {o.tokenOut.ticker}
                </div>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  STATUS_STYLE[o.status] ?? "bg-white/10 text-muted"
                }`}
              >
                {o.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-surface/40 px-4 py-12 text-center text-sm text-muted">
      {children}
    </div>
  );
}
