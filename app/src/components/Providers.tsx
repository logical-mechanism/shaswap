"use client";

import { MeshProvider } from "@meshsdk/react";
import type { ReactNode } from "react";
import { ToastProvider } from "./Toast";
import { WalletWatcher } from "./WalletWatcher";

/**
 * Client-side context providers for the app.
 *
 * `MeshProvider` supplies wallet state (CIP-30) to the whole tree via the
 * `useWallet` / `useAddress` / `useLovelace` hooks. `ToastProvider` layers an
 * app-wide toast channel on top (and renders the Toaster), and `WalletWatcher`
 * turns wallet/network transitions into toasts. All must be client components,
 * so they are isolated here and mounted once from the root layout.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <MeshProvider>
      <ToastProvider>
        <WalletWatcher />
        {children}
      </ToastProvider>
    </MeshProvider>
  );
}
