"use client";

import { useNetwork, useWallet } from "@meshsdk/react";
import { APP_CONFIG } from "@/lib/config";
import { useWalletCollateral } from "./useWalletCollateral";

export interface WriteGate {
  connected: boolean;
  networkId: number | undefined;
  wrongNetwork: boolean;
  networkReady: boolean;
  hasCollateral: boolean;
  collateralReady: boolean;
  needsCollateral: boolean;
  recheckCollateral: () => void;
  /**
   * Disabled-button label for a COMMON blocker (connect → wrong-network → checking →
   * collateral), or null once they're all satisfied — callers append their own
   * flow-specific reasons after this.
   */
  baseReason: string | null;
}

/**
 * Shared write-flow gating: the connect → wrong-network → network-ready → collateral
 * ladder that every script-spend action (reclaim / LP add+remove / pool create) repeated
 * verbatim. Fail-closed is preserved: the network is "ready" only once the wallet's id is
 * KNOWN and equal to the app's, and `collateralReady` stays true while the check is still
 * in flight so a wallet that sets collateral on demand isn't blocked prematurely.
 *
 * Not used by the plain swap: posting an order is a wallet payment (no script, no
 * collateral), so it keeps its own lighter, collateral-free gating.
 */
export function useWriteGate({
  requireCollateral = false,
}: { requireCollateral?: boolean } = {}): WriteGate {
  const { connected } = useWallet();
  const networkId = useNetwork();
  const {
    hasCollateral,
    loading: collateralLoading,
    recheck: recheckCollateral,
  } = useWalletCollateral();

  const wrongNetwork =
    connected && networkId !== undefined && networkId !== APP_CONFIG.networkId;
  const networkReady = connected && networkId === APP_CONFIG.networkId;
  const collateralReady =
    !requireCollateral || hasCollateral || collateralLoading;
  const needsCollateral =
    requireCollateral && connected && !hasCollateral && !collateralLoading;

  const baseReason: string | null = !connected
    ? "Connect wallet"
    : wrongNetwork
      ? "Wrong network"
      : !networkReady
        ? "Checking network…"
        : needsCollateral
          ? "Set a collateral UTXO"
          : null;

  return {
    connected,
    networkId,
    wrongNetwork,
    networkReady,
    hasCollateral,
    collateralReady,
    needsCollateral,
    recheckCollateral,
    baseReason,
  };
}
