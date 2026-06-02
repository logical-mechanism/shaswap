"use client";

import { usePools } from "@/hooks/usePools";
import { formatUnits } from "@/lib/format";

export default function PoolsPage() {
  const { pools, loading, error } = usePools();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pools</h1>
        <p className="mt-1 text-sm text-muted">
          Live preprod liquidity pools, read through the data-access layer.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          Failed to load pools: {error}
        </div>
      )}

      {loading && <SkeletonRows />}

      {!loading && !error && pools.length === 0 && (
        <Empty>No pools found.</Empty>
      )}

      {!loading && pools.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-surface/60">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-white/5">
                <th className="px-4 py-3 font-medium">Pair</th>
                <th className="px-4 py-3 font-medium">Reserves</th>
                <th className="px-4 py-3 text-right font-medium">Fee</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-4 py-3 font-medium">
                    {p.tokenA.ticker} / {p.tokenB.ticker}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted">
                    {formatUnits(p.reserveA, p.tokenA.decimals)}{" "}
                    {p.tokenA.ticker} ·{" "}
                    {formatUnits(p.reserveB, p.tokenB.decimals)}{" "}
                    {p.tokenB.ticker}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted">
                    {(p.feeBps / 100).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-xl border border-white/5 bg-white/5"
        />
      ))}
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
