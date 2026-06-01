"use client";

import { MeshProvider } from "@meshsdk/react";
import type { ReactNode } from "react";

/**
 * Client-side context providers for the app.
 *
 * `MeshProvider` supplies wallet state (CIP-30) to the whole tree via the
 * `useWallet` / `useAddress` / `useLovelace` hooks. It must be a client
 * component, so it is isolated here and mounted once from the root layout.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <MeshProvider>{children}</MeshProvider>;
}
