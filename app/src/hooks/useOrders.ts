"use client";

import { useEffect, useState } from "react";
import type { WalletPosition } from "@/lib/data";
import { fetchOrders } from "@/lib/client/api";

/**
 * Loads a wallet's orders through our /api/orders route. Stays empty until an
 * address is provided (wallet connected). State writes happen inside the
 * deferred timer callback so the effect body never sets state synchronously.
 */
export function useOrders(address: string | undefined) {
  const [orders, setOrders] = useState<WalletPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      if (!address) {
        setOrders([]);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      fetchOrders(address, ac.signal)
        .then((o) => {
          if (!ac.signal.aborted) setOrders(o);
        })
        .catch((e: unknown) => {
          if (!ac.signal.aborted) setError(String(e));
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, 0);

    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [address]);

  return { orders, loading, error };
}
