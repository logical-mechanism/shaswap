"use client";

import { use } from "react";
import Link from "next/link";
import { usePools } from "@/hooks/usePools";
import { LiquidityPanel } from "@/components/pools/LiquidityPanel";
import { formatUnits } from "@/lib/format";

/**
 * Dedicated pool-management page: add / remove liquidity for one pool. The pool id in
 * the route is the pool NFT unit (`policy+name`, hex). We resolve the pool's display
 * metadata via the read-only pools list; the `LiquidityPanel` resolves the live pool
 * UTXO (reserves + circulating LP) through the data seam for the deposit/withdraw math.
 */
export default function PoolManagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const poolId = decodeURIComponent(id);
  const { pools, loading, error } = usePools();
  const pool = pools.find((p) => p.id === poolId);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:px-6 sm:py-14">
      <Link
        href="/pools"
        className="mb-4 inline-block text-sm text-muted transition-colors hover:text-foreground"
      >
        ← All pools
      </Link>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
          Failed to load pool: {error}
        </div>
      )}

      {loading && !pool && (
        <div className="h-64 animate-pulse rounded-2xl border border-white/5 bg-white/5" />
      )}

      {!loading && !error && !pool && (
        <div className="rounded-2xl border border-white/10 bg-surface/40 px-4 py-12 text-center text-sm text-muted">
          Pool not found yet. If you just created it, it may still be confirming
          on-chain — this page refreshes automatically.
        </div>
      )}

      {pool && (
        <>
          <header className="mb-4">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              {pool.tokenA.ticker} / {pool.tokenB.ticker}
              {pool.firstDeposit && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-normal text-amber-300">
                  Empty — needs first deposit
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm tabular-nums text-muted">
              {pool.firstDeposit ? (
                <>No liquidity yet · fee {(pool.feeBps / 100).toFixed(2)}%</>
              ) : (
                <>
                  {formatUnits(pool.reserveA, pool.tokenA.decimals)}{" "}
                  {pool.tokenA.ticker} ·{" "}
                  {formatUnits(pool.reserveB, pool.tokenB.decimals)}{" "}
                  {pool.tokenB.ticker} · fee {(pool.feeBps / 100).toFixed(2)}%
                </>
              )}
            </p>
          </header>

          <LiquidityPanel pool={pool} />
        </>
      )}
    </div>
  );
}
