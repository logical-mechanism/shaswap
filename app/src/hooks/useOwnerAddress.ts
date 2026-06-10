"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet/hooks";

/**
 * Resolve the connected wallet's CHANGE address — the payment key hash orders and LP intents
 * are posted under (`postOrder` / `postLpIntent` use `getChangeAddress`) — so HD wallets that
 * rotate receive addresses still match their own resting items and their local activity log.
 *
 * Shared by the Orders and Portfolio surfaces so both key off the SAME address (extracted from
 * the Orders page so the two can never drift). `ownerAddr` is `undefined` until it resolves and
 * whenever disconnected; `ownerError` is true once the read has been attempted and failed (the
 * wallet errored / disconnected mid-call) so the caller can show a calm reconnect hint instead
 * of hanging on a loading state forever. State is only written from the async callback, never
 * synchronously in the effect body (the project's effect convention).
 */
export function useOwnerAddress(): {
  ownerAddr: string | undefined;
  ownerError: boolean;
} {
  const { connected, wallet } = useWallet();
  const [owner, setOwner] = useState<string | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    wallet
      .getChangeAddress()
      .then((a) => {
        if (!cancelled) {
          setOwner(a);
          setAttempted(true);
        }
      })
      .catch(() => {
        if (!cancelled) setAttempted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, wallet]);

  const ownerAddr = connected ? owner : undefined;
  const ownerError = connected && attempted && !ownerAddr;
  return { ownerAddr, ownerError };
}
