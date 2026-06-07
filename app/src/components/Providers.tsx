"use client";

import { useEffect, type ReactNode } from "react";
import { ToastProvider } from "./Toast";
import { LegalConsentProvider, useLegalConsent } from "./legal/LegalConsent";
import { AppWalletProvider } from "@/lib/wallet/context";
import { useWallet } from "@/lib/wallet/hooks";
import { WalletWatcher } from "./WalletWatcher";

/**
 * Client-side context providers for the app — all mesh-free, so the page loads, hydrates,
 * and settles with zero wallet code on the main thread.
 *
 * `AppWalletProvider` owns wallet state and lazily loads the heavy `@meshsdk` stack
 * (`MeshBridge`) only on the user's first interaction (see `@/lib/wallet/context`).
 * `ToastProvider` and `LegalConsentProvider` are mesh-free too. `WalletWatcher` (toasts)
 * and `LegalConsentReconciler` read wallet state through the context, so they stay
 * eager/mesh-free and simply react when the bridge later streams real state in.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <LegalConsentProvider>
        <AppWalletProvider>
          <WalletWatcher />
          <LegalConsentReconciler />
          {children}
        </AppWalletProvider>
      </LegalConsentProvider>
    </ToastProvider>
  );
}

/**
 * Re-gates a persisted wallet that auto-reconnected past the Terms click-through after a
 * `LEGAL.version` bump: if we're connected while the current terms are unaccepted,
 * disconnect so the next connect must pass the gate. Reads wallet state through the
 * mesh-free context, so it carries no `@meshsdk` dependency.
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
