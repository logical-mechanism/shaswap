"use client";

import { useEffect, useState } from "react";
import type { Quote } from "@/lib/data";
import { fetchQuote } from "@/lib/client/api";

/**
 * Fetches a (mock) price quote whenever the pair or amount changes, debounced.
 * Returns the quote read THROUGH our /api/quote route — never a provider SDK.
 *
 * `amount` is in base units (decimal string). Pass an empty/zero amount and the
 * hook stays idle (no quote, no request).
 *
 * All state writes happen inside the (deferred) timer callback so the effect
 * body never sets state synchronously.
 */
export function useQuote(
  inUnit: string | undefined,
  outUnit: string | undefined,
  amount: string,
) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAmount = !!amount && /^[0-9]+$/.test(amount) && BigInt(amount) > 0n;
  const ready = !!inUnit && !!outUnit && inUnit !== outUnit && hasAmount;

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(
      () => {
        if (!ready || !inUnit || !outUnit) {
          setQuote(null);
          setLoading(false);
          setError(null);
          return;
        }
        setLoading(true);
        setError(null);
        fetchQuote(inUnit, outUnit, amount, ac.signal)
          .then((q) => {
            if (!ac.signal.aborted) setQuote(q);
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
      clearTimeout(t);
      ac.abort();
    };
  }, [ready, inUnit, outUnit, amount]);

  return { quote, loading, error };
}
