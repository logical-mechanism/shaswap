"use client";

import {
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { ToastProvider } from "./Toast";
import { LegalConsentProvider } from "./legal/LegalConsent";

/**
 * Client-side context providers for the app.
 *
 * The wallet stack (`@meshsdk/react` → `@meshsdk/wallet` → `@meshsdk/core-cst`, a
 * ~7.5MB WASM serialization bundle) is by far the heaviest thing the app loads, and
 * merely importing `MeshProvider` drags all of it into the initial bundle. So the
 * wallet providers are split into their own chunk (`./WalletProviders`) and mounted
 * AFTER first paint via a dynamic `import()`: the page shell renders immediately and
 * the wallet machinery streams in behind it.
 *
 * `ToastProvider` and `LegalConsentProvider` stay eager — they're mesh-free, and the
 * legal gate must already be present for the Connect button (`WalletBar`) the moment it
 * mounts (`useLegalConsent` throws without its provider), while the toast channel is
 * needed app-wide.
 *
 * Until the wallet chunk resolves, the `@meshsdk/react` hooks return a safe disconnected
 * default (their context ships a non-throwing default value), so the wallet-aware leaves
 * (`WalletBar`, `SwapCard`) render their disconnected state and re-render once
 * `MeshProvider` mounts. The one-time re-mount when the provider is inserted happens
 * within the first beat, before any wallet interaction is possible (connecting needs the
 * same chunk).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [WalletProviders, setWalletProviders] = useState<ComponentType<{
    children: ReactNode;
  }> | null>(null);

  useEffect(() => {
    let active = true;
    // Kick off the wallet chunk right after first paint. Once it resolves, MeshProvider
    // mounts and the subtree re-renders under real wallet context.
    void import("./WalletProviders").then((m) => {
      if (active) setWalletProviders(() => m.default);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <ToastProvider>
      <LegalConsentProvider>
        {WalletProviders ? (
          <WalletProviders>{children}</WalletProviders>
        ) : (
          children
        )}
      </LegalConsentProvider>
    </ToastProvider>
  );
}
