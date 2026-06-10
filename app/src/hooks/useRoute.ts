"use client";

import { useCallback, useEffect, useState } from "react";
import type { Route } from "@/lib/data";
import { fetchRoute } from "@/lib/client/api";

/**
 * Fetches the best SPLIT route whenever the pair, amount, or tip changes, debounced.
 * Returns the route read THROUGH our /api/route — never a provider SDK. A one-leg route is
 * the single-best-pool case; the router only spreads across shards when the extra output
 * beats the extra per-leg tip, so the `tip` is a real input here (not just metadata).
 *
 * `amount` and `tipLovelace` are base-unit decimal strings. An empty/zero amount keeps the
 * hook idle (no route, no request). All state writes happen inside the deferred timer
 * callback so the effect body never sets state synchronously (project effect convention).
 */
export function useRoute(
  inUnit: string | undefined,
  outUnit: string | undefined,
  amount: string,
  tipLovelace: string,
) {
  const [route, setRoute] = useState<Route | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const hasAmount = !!amount && /^[0-9]+$/.test(amount) && BigInt(amount) > 0n;
  const tip = tipLovelace && /^[0-9]+$/.test(tipLovelace) ? tipLovelace : "0";
  const ready = !!inUnit && !!outUnit && inUnit !== outUnit && hasAmount;

  useEffect(() => {
    const ac = new AbortController();
    // Drop a stale error the instant inputs change (deferred via a 0ms timer — no
    // synchronous setState in the effect body); the debounced fetch still waits its delay.
    const clearErr = setTimeout(() => setError(null), 0);
    const t = setTimeout(
      () => {
        if (!ready || !inUnit || !outUnit) {
          setRoute(null);
          setLoading(false);
          setError(null);
          return;
        }
        setLoading(true);
        setError(null);
        fetchRoute(inUnit, outUnit, amount, tip, ac.signal)
          .then((r) => {
            if (!ac.signal.aborted) setRoute(r);
          })
          .catch((e: unknown) => {
            if (!ac.signal.aborted) setError(String(e));
          })
          .finally(() => {
            if (!ac.signal.aborted) setLoading(false);
          });
      },
      ready ? 250 : 0,
    );

    return () => {
      clearTimeout(clearErr);
      clearTimeout(t);
      ac.abort();
    };
  }, [ready, inUnit, outUnit, amount, tip, nonce]);

  return { route, loading, error, reload };
}
