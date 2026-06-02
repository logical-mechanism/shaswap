"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchPoolUtxo } from "@/lib/client/api";
import { decodePoolDatum } from "@/lib/chain/datums";
import { poolStats, type PoolStats, type PoolView } from "@/lib/chain/lp";

/**
 * Resolve the live pool UTXO (through the data seam) and derive its accounting
 * (reserves, circulating LP, LP unit, first-deposit flag) for the LP deposit/withdraw
 * previews. `reload()` re-fetches after a submitted tx so the panel reflects the new
 * pool state. The actual deposit/withdraw builders re-resolve a fresh UTXO at submit,
 * so this is for preview/UX only.
 */
export function usePoolUtxo(poolId: string | undefined) {
  const [view, setView] = useState<PoolView | null>(null);
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // All state is set from the async callbacks only (never synchronously in the effect
  // body) — the project's effect convention (cf. the Orders page). On reload the data
  // refreshes in place; we don't flip back to a loading skeleton.
  useEffect(() => {
    if (!poolId) return;
    const ac = new AbortController();
    fetchPoolUtxo(poolId, ac.signal)
      .then((utxo) => {
        if (ac.signal.aborted) return;
        if (!utxo || !utxo.output.plutusData) {
          setView(null);
          setStats(null);
          setError("Pool UTXO not found on-chain.");
          return;
        }
        const datum = decodePoolDatum(utxo.output.plutusData);
        const v: PoolView = { value: utxo.output.amount, datum };
        setView(v);
        setStats(poolStats(v));
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [poolId, nonce]);

  return { view, stats, loading, error, reload };
}
