"use client";

import { use } from "react";
import Link from "next/link";
import { usePools } from "@/hooks/usePools";
import { LiquidityPanel } from "@/components/pools/LiquidityPanel";
import { formatUnits } from "@/lib/format";
import { Pip } from "@/components/Pip";
import { PipLoading } from "@/components/PipLoading";
import { Sprout } from "@/components/Sprout";
import { RefreshIcon } from "@/components/RefreshIcon";

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
  const { pools, loading, refreshing, error, reload } = usePools();
  const pool = pools.find((p) => p.id === poolId);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:px-6 sm:py-14">
      <Link
        href="/pools"
        className="mb-4 inline-block text-sm text-muted transition-colors hover:text-accent"
      >
        ← All pools
      </Link>

      {error && (
        <div className="k-note k-note-danger p-4 text-sm">
          <div className="flex items-center gap-2">
            <Pip size={24} mood="calm" still />
            <span className="font-bold">Pip couldn’t open this pool.</span>
          </div>
          <div className="mt-1 break-words text-xs text-muted">{error}</div>
        </div>
      )}

      {loading && !pool && (
        <div className="k-card">
          <PipLoading label="Pip’s finding this pool…" />
        </div>
      )}

      {!loading && !error && !pool && (
        <div className="k-card flex flex-col items-center px-4 py-12 text-center text-sm text-muted">
          <Pip size={56} mood="thinking" />
          <p className="mt-3 max-w-xs">
            Pip can’t find this garden yet. If you just planted it, it may still be taking
            root (~20–40s).
          </p>
          <button
            type="button"
            onClick={reload}
            disabled={loading || refreshing}
            aria-busy={loading || refreshing}
            className="k-btn-ghost mt-4 px-4 py-2 text-sm disabled:opacity-70"
          >
            <RefreshIcon busy={loading || refreshing} /> Refresh
          </button>
        </div>
      )}

      {pool && (
        <>
          <header className="mb-4">
            <div className="flex items-center gap-2">
              <Pip size={30} mood={pool.firstDeposit ? "sleepy" : "happy"} />
              <Sprout
                state={pool.firstDeposit ? "seed" : "growing"}
                size={22}
                className="shrink-0"
              />
              <h1 className="flex flex-wrap items-center gap-2 font-display text-2xl font-extrabold text-ink">
                {pool.tokenA.ticker} / {pool.tokenB.ticker}
                {pool.firstDeposit && (
                  <span className="k-chip k-chip-warn">
                    Empty, needs first deposit
                  </span>
                )}
              </h1>
            </div>
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
