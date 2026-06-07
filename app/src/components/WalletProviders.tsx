"use client";

import { useEffect, type ReactNode } from "react";
import { MeshProvider, useWallet } from "@meshsdk/react";
import { WalletWatcher } from "./WalletWatcher";
import { useLegalConsent } from "./legal/LegalConsent";

/**
 * The deferred wallet-context boundary.
 *
 * This module statically imports `@meshsdk/react`, which transitively pulls
 * `@meshsdk/wallet` → `@meshsdk/core-cst` — a ~7.5MB WASM serialization bundle that
 * dominates the page's JS and costs seconds of main-thread time to instantiate. So
 * this module is ONLY ever reached via a dynamic `import()` from `Providers` (never a
 * static import), which keeps all of that weight out of the initial bundle and off the
 * first-paint critical path.
 *
 * It mounts `MeshProvider` around the app plus the two headless, wallet-aware effects:
 * `WalletWatcher` (connect / wrong-network toasts) and `LegalConsentReconciler`
 * (re-gates a persisted wallet after a terms-version bump). The consent gate itself
 * lives in the eager, mesh-free `LegalConsentProvider` ABOVE this boundary — only its
 * mesh-dependent reconcile effect lives here.
 */
export default function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <MeshProvider>
      <WalletWatcher />
      <LegalConsentReconciler />
      {children}
    </MeshProvider>
  );
}

/**
 * A persisted wallet auto-reconnects on load WITHOUT passing the connect gate, and a
 * `LEGAL.version` bump won't re-prompt an already-connected user (they render the
 * connected menu, not the gated connect button). So if we're connected while the
 * current terms are unaccepted, disconnect — the next connect must pass the gate.
 *
 * This was lifted out of `LegalConsentProvider` so that provider can stay mesh-free
 * (and therefore eager): the disconnect path is the provider's only `@meshsdk/react`
 * dependency, and it's only meaningful once a wallet is actually connected — which can
 * only happen after this deferred chunk has loaded anyway.
 */
function LegalConsentReconciler() {
  const { connected, disconnect } = useWallet();
  const { isAccepted } = useLegalConsent();

  useEffect(() => {
    if (connected && !isAccepted()) {
      disconnect();
    }
  }, [connected, disconnect, isAccepted]);

  return null;
}
