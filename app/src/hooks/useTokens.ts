"use client";

import { useEffect, useState } from "react";
import type { TokenInfo } from "@/lib/data";
import { fetchTokens } from "@/lib/client/api";

/** Loads the selectable token list through our /api/tokens route. */
export function useTokens() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchTokens(ac.signal)
      .then((t) => {
        if (!ac.signal.aborted) setTokens(t);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  return { tokens, loading, error };
}
