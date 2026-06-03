"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@meshsdk/react";

/**
 * Proactively detect whether the connected wallet has a collateral UTXO set. The
 * script-spend write flows (reclaim, deposit, withdraw, create pool, close pool) all
 * require one — without this the need only surfaces as a failed signing attempt. This
 * reads the CIP-30 wallet API (`getCollateral()`) directly: a WALLET call, not a
 * chain-data provider call, so the data-access seam is untouched. Re-queries whenever the
 * connected wallet identity changes.
 *
 * `loading` is true until the first check resolves. Gate buttons on
 * `hasCollateral || loading` so a wallet that sets collateral on demand isn't blocked
 * before we actually know. (Posting a plain swap order needs no collateral — don't gate
 * that flow on this.)
 */
export function useWalletCollateral() {
  const { connected, wallet } = useWallet();
  const [hasCollateral, setHasCollateral] = useState(false);
  const [loading, setLoading] = useState(true);

  // All state is written from async/deferred callbacks only (never synchronously in the
  // effect body) — the project's effect convention (cf. the other hooks).
  useEffect(() => {
    let cancelled = false;
    if (!connected) {
      const id = setTimeout(() => {
        if (!cancelled) {
          setHasCollateral(false);
          setLoading(false);
        }
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(id);
      };
    }
    Promise.resolve()
      .then(() => wallet.getCollateral())
      .then((utxos) => {
        if (!cancelled) {
          setHasCollateral(Array.isArray(utxos) && utxos.length > 0);
          setLoading(false);
        }
      })
      .catch(() => {
        // Some wallets throw when no collateral is set — treat as absent, never crash.
        if (!cancelled) {
          setHasCollateral(false);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);

  return { hasCollateral, loading };
}
