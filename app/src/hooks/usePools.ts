"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Pool } from "@/lib/data";
import { fetchPools } from "@/lib/client/api";

/**
 * Loads pools through our /api/pools route (the data abstraction). Read once on mount;
 * refreshed only on demand via `reload()` (a Refresh button) — we deliberately do NOT
 * poll on an interval, so an idle/backgrounded tab spends no Blockfrost quota (the app
 * is a non-custodial front-end over a shared, rate-limited provider key — see
 * documentation/app-data-caching.md). A just-created pool appears on the next refresh.
 */
export function usePools() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Once a list has loaded, a later POLL failure (a transient network blip) must NOT
  // surface an error banner over the still-valid list — the consumers render the table
  // and the error banner independently, so we'd stack "Failed to load" on working data.
  // Keep showing the stale list; only a genuine first-load failure (no data) surfaces.
  const loaded = useRef(false);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // On reload the list refreshes in place; we don't flip back to a loading skeleton.
  useEffect(() => {
    const ac = new AbortController();
    fetchPools(ac.signal)
      .then((p) => {
        if (ac.signal.aborted) return;
        setPools(p);
        loaded.current = true;
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted && !loaded.current) setError(String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [nonce]);

  return { pools, loading, error, reload };
}
