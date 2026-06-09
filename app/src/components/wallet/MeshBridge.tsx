"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MeshProvider,
  useAddress,
  useAssets,
  useLovelace,
  useNetwork,
  useWallet,
  useWalletList,
} from "@meshsdk/react";
// Type-only — erased at build (this module is already the heavy one, but keep the seam clean).
import type { Asset } from "@meshsdk/core";
import type { AppWalletState, BridgeActions } from "@/lib/wallet/context";

/**
 * The Mesh wallet bridge — the ONE module that statically imports `@meshsdk/react`
 * (transitively `@meshsdk/wallet` → `@meshsdk/core-cst`, the ~7.5MB WASM serialization
 * lib). It is only ever reached via the dynamic `import()` in `AppWalletProvider`, which
 * fires on the user's first interaction — so all of that weight stays off the initial
 * load and never runs during an automated/headless page load.
 *
 * It mounts a local `MeshProvider` and mirrors the real Mesh wallet state up into
 * `AppWalletContext` via `onState`, and registers connect/disconnect via `registerActions`.
 * Renders nothing itself. Because the rest of the app reads `AppWalletContext` (not Mesh
 * directly), this bridge wraps only itself — so loading it updates context without
 * re-mounting the app tree.
 */
interface BridgeProps {
  onState: (s: AppWalletState) => void;
  registerActions: (a: BridgeActions) => void;
}

export default function MeshBridge(props: BridgeProps) {
  return (
    <MeshProvider>
      <Bridge {...props} />
    </MeshProvider>
  );
}

function Bridge({ onState, registerActions }: BridgeProps) {
  const { connected, connecting, name, wallet, connect, disconnect } = useWallet();
  const address = useAddress();
  const lovelace = useLovelace();
  const assets = useAssets();
  const networkId = useNetwork();
  const walletList = useWalletList();

  // Event-driven balance refresh (NO polling). Mesh reads the wallet's lovelace/assets ONCE
  // on connect, so after a swap/deposit — or any change made in the wallet itself — the shown
  // balance would otherwise go stale. We re-read straight from the connected wallet on demand
  // and let those fresher values override Mesh's initial snapshot. The override is tagged with
  // the address it was read for, so on an account switch it simply stops applying (no reset
  // effect — synchronous setState in an effect is lint-blocked and causes cascading renders).
  const [fresh, setFresh] = useState<{
    address?: string;
    lovelace?: string;
    assets?: Asset[];
  }>({});

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const [lov, ass] = await Promise.all([
        wallet.getLovelace(),
        wallet.getAssets(),
      ]);
      setFresh({ address, lovelace: lov, assets: ass });
    } catch {
      // a wallet read can transiently fail — keep the last known values, try again next event
    }
  }, [wallet, address]);

  // Refresh on tab focus / re-visibility — covers the user returning from their wallet popup
  // after signing, or from another tab, with no timer.
  useEffect(() => {
    if (!connected) return;
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, refresh]);

  // The fresh override only applies to the account it was read for (else fall back to Mesh's
  // own snapshot — which already tracks the current account).
  const overrideLive = fresh.address !== undefined && fresh.address === address;

  // Push the live Mesh state (with any fresher balance override) up into AppWalletContext.
  useEffect(() => {
    onState({
      ready: true,
      connected,
      connecting,
      name,
      wallet,
      address,
      lovelace: overrideLive ? fresh.lovelace : lovelace,
      assets: overrideLive ? fresh.assets : assets,
      networkId,
      walletList: walletList.map((w) => ({
        name: w.name,
        icon: w.icon,
        version: w.version,
      })),
    });
  }, [
    onState,
    connected,
    connecting,
    name,
    wallet,
    address,
    lovelace,
    assets,
    fresh,
    overrideLive,
    networkId,
    walletList,
  ]);

  // Expose connect/disconnect/refresh to the provider (connect persists by default, matching
  // the app's prior `connect(name, true)` behavior).
  useEffect(() => {
    registerActions({
      connect: (n: string, persist = true) => connect(n, persist),
      disconnect,
      refresh,
    });
  }, [registerActions, connect, disconnect, refresh]);

  return null;
}
