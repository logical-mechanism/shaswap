"use client";

import { useEffect } from "react";
import {
  MeshProvider,
  useAddress,
  useAssets,
  useLovelace,
  useNetwork,
  useWallet,
  useWalletList,
} from "@meshsdk/react";
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

  // Push the live Mesh state up into AppWalletContext whenever any piece changes.
  useEffect(() => {
    onState({
      ready: true,
      connected,
      connecting,
      name,
      wallet,
      address,
      lovelace,
      assets,
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
    networkId,
    walletList,
  ]);

  // Expose connect/disconnect to the provider (connect persists by default, matching the
  // app's prior `connect(name, true)` behavior).
  useEffect(() => {
    registerActions({
      connect: (n: string, persist = true) => connect(n, persist),
      disconnect,
    });
  }, [registerActions, connect, disconnect]);

  return null;
}
