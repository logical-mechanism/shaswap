"use client";

import { useCallback, useEffect, useState } from "react";
import type { Pool } from "@/lib/data";
import { fetchPools } from "@/lib/client/api";

/** Re-poll the pools list so a just-created pool appears without a manual refresh. */
const POOLS_POLL_MS = 15_000;

/** Loads pools through our /api/pools route (the data abstraction). */
export function usePools() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // On reload the list refreshes in place; we don't flip back to a loading skeleton.
  useEffect(() => {
    const ac = new AbortController();
    fetchPools(ac.signal)
      .then((p) => {
        if (ac.signal.aborted) return;
        setPools(p);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [nonce]);

  // Poll so a just-created pool shows up without a manual refresh — mirrors usePoolUtxo.
  // Self-heals the create → "add initial liquidity" (/pools/[id]) hand-off during the
  // on-chain indexing gap, where the pool isn't in the list yet (calls reload from a
  // timer — never a synchronous setState in the effect body).
  useEffect(() => {
    const id = setInterval(reload, POOLS_POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  return { pools, loading, error, reload };
}
