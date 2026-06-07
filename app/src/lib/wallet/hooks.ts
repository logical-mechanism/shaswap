"use client";

// Type-only — erased at build, pulls no @meshsdk runtime.
import type { IWallet } from "@meshsdk/core";
import { useAppWallet } from "./context";

/**
 * Drop-in replacements for the `@meshsdk/react` wallet hooks, sourced from our mesh-free
 * `AppWalletContext`. Components import these instead of `@meshsdk/react` so they carry no
 * static dependency on the heavy wallet/serialization stack — that lives only in the
 * lazily-loaded `MeshBridge`. The return shapes mirror the Mesh hooks so call sites are
 * unchanged. See `./context` for how the real Mesh state is bridged in on demand.
 */

export function useWallet() {
  const w = useAppWallet();
  return {
    connected: w.connected,
    connecting: w.connecting,
    name: w.name,
    // Mirror Mesh's contract: `wallet` is typed non-optional and only touched after a
    // `connected` check (it's genuinely set once connected). Avoids re-guarding callers.
    wallet: w.wallet as IWallet,
    connect: w.connect,
    disconnect: w.disconnect,
  };
}

export function useAddress(): string | undefined {
  return useAppWallet().address;
}

export function useLovelace(): string | undefined {
  return useAppWallet().lovelace;
}

export function useNetwork(): number | undefined {
  return useAppWallet().networkId;
}

export function useAssets() {
  return useAppWallet().assets;
}

export function useWalletList() {
  return useAppWallet().walletList;
}
