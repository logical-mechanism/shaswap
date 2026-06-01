"use client";

import { useEffect, useState } from "react";
import type { Pool } from "@/lib/data";
import { fetchPools } from "@/lib/client/api";

/** Loads pools through our /api/pools route (the data abstraction). */
export function usePools() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchPools(ac.signal)
      .then((p) => {
        if (!ac.signal.aborted) setPools(p);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  return { pools, loading, error };
}
