"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchPoolUtxo } from "@/lib/client/api";
import { decodePoolDatum } from "@/lib/chain/datums";
import { poolStats, type PoolStats, type PoolView } from "@/lib/chain/lp";

/** How often to re-poll the pool UTXO so a just-confirmed deposit/withdraw shows up. */
const POOL_POLL_MS = 15_000;

/**
 * Resolve the live pool UTXO (through the data seam) and derive its accounting
 * (reserves, circulating LP, LP unit, first-deposit flag) for the LP deposit/withdraw
 * previews. `reload()` re-fetches on demand, and the hook also polls on an interval so
 * the view self-heals after a tx confirms — without it, a deposit's immediate reload
 * runs DURING the indexing gap and re-caches the pre-deposit state (e.g. circ == 0),
 * which then makes the withdraw preview reject a perfectly valid amount. The actual
 * deposit/withdraw builders re-resolve a fresh UTXO at submit, so this is for preview/UX.
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
        // Clear stale view/stats so the panel surfaces the error instead of rendering
        // a previous successful load's reserves (the panel renders on `stats && view`).
        if (!ac.signal.aborted) {
          setView(null);
          setStats(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [poolId, nonce]);

  // Poll so a just-confirmed deposit/withdraw is reflected without a manual refresh
  // (calls reload from a timer — never a synchronous setState in the effect body).
  useEffect(() => {
    if (!poolId) return;
    const id = setInterval(reload, POOL_POLL_MS);
    return () => clearInterval(id);
  }, [poolId, reload]);

  return { view, stats, loading, error, reload };
}
