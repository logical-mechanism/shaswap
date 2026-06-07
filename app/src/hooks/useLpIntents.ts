"use client";

import { useCallback, useEffect, useState } from "react";
import type { LpIntentPosition } from "@/lib/data";
import { fetchLpIntents } from "@/lib/client/api";
import { toUserMessage } from "@/lib/client/errors";

/**
 * Loads a wallet's open batcher-fulfilled LP intents through /api/lp-intents — the LP
 * analogue of `useOrders`. Stays empty until an address is provided (wallet connected).
 * `loading` is derived (have an address, haven't resolved results for it) so there's no
 * first-frame flash; state is only written inside async callbacks. `reload()` re-fetches
 * (e.g. after posting/reclaiming an intent). Returns `[]` on a network where LP intents
 * aren't live yet (the address resolves but holds nothing).
 */
export function useLpIntents(address: string | undefined) {
  const [intents, setIntents] = useState<LpIntentPosition[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setLoadedFor(null);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!address) return;
    const ac = new AbortController();
    fetchLpIntents(address, ac.signal)
      .then((i) => {
        if (ac.signal.aborted) return;
        setIntents(i);
        setError(null);
        setLoadedFor(address);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(toUserMessage(e));
        setLoadedFor(address);
      });
    return () => ac.abort();
  }, [address, nonce]);

  const resolved = !!address && loadedFor === address;
  return {
    intents: address ? intents : [],
    loading: !!address && !resolved,
    error: resolved ? error : null,
    reload,
  };
}
