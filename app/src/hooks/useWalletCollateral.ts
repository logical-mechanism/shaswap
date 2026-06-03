"use client";

import { useCallback, useEffect, useState } from "react";
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
 *
 * `recheck()` re-queries on demand so the "set a collateral UTXO and retry" guidance is
 * actually actionable in-app — without it the only recovery was a full reconnect. The
 * hook also re-queries automatically when the tab regains focus WHILE collateral is
 * still missing (the user typically tabs away to their wallet to set it, then back).
 */
export function useWalletCollateral() {
  const { connected, wallet } = useWallet();
  const [hasCollateral, setHasCollateral] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

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
  }, [connected, wallet, nonce]);

  // Auto-recheck when the user returns to the app while collateral is still absent (they
  // typically set it in their wallet — another tab OR a separate window — then come back).
  // Both signals are needed for full coverage: 'visibilitychange' catches tab switches
  // within the browser; window 'focus' catches re-focusing the browser window from another
  // app (a desktop wallet) when the tab itself never went hidden. When both happen to fire
  // for one return it's just one extra cheap getCollateral — coverage beats the micro-opt.
  useEffect(() => {
    if (!connected || hasCollateral) return;
    const recheckIfVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("focus", recheckIfVisible);
    document.addEventListener("visibilitychange", recheckIfVisible);
    return () => {
      window.removeEventListener("focus", recheckIfVisible);
      document.removeEventListener("visibilitychange", recheckIfVisible);
    };
  }, [connected, hasCollateral, recheck]);

  return { hasCollateral, loading, recheck };
}
