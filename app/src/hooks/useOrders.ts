"use client";

import { useEffect, useState } from "react";
import type { WalletPosition } from "@/lib/data";
import { fetchOrders } from "@/lib/client/api";

/**
 * Loads a wallet's orders through our /api/orders route. Stays empty until an
 * address is provided (wallet connected).
 *
 * `loading` is DERIVED (we have an address but haven't resolved results for it
 * yet) rather than a separately-toggled flag — so there's no first-frame
 * "not loading, empty" flash, and state is only written inside async callbacks
 * (never synchronously in the effect body).
 */
export function useOrders(address: string | undefined) {
  const [orders, setOrders] = useState<WalletPosition[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    const ac = new AbortController();
    fetchOrders(address, ac.signal)
      .then((o) => {
        if (ac.signal.aborted) return;
        setOrders(o);
        setError(null);
        setLoadedFor(address);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(String(e));
        setLoadedFor(address);
      });
    return () => ac.abort();
  }, [address]);

  const resolved = !!address && loadedFor === address;
  return {
    orders: address ? orders : [],
    loading: !!address && !resolved,
    error: resolved ? error : null,
  };
}
