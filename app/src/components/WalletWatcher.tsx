"use client";

import { useEffect, useRef } from "react";
import { useNetwork, useWallet } from "@/lib/wallet/hooks";
import { APP_CONFIG, networkLabel } from "@/lib/config";
import { useToast } from "./Toast";

/**
 * Headless watcher (renders nothing) that turns wallet/network transitions into
 * toasts. Mounted once, inside MeshProvider + ToastProvider.
 *
 * - connect / disconnect → a friendly toast, but only after a short "arm" delay
 *   so a *persisted* wallet auto-reconnecting on page load doesn't fire a toast
 *   every time the app loads.
 * - wrong network → fires immediately (even at load), because being on the wrong
 *   network is the one thing the user must notice before doing anything.
 */
export function WalletWatcher() {
  const { connected } = useWallet();
  const networkId = useNetwork();
  const { toast } = useToast();

  const armed = useRef(false);
  const prevConnected = useRef<boolean | null>(null);
  const prevMismatch = useRef<boolean | null>(null);

  // Arm connect/disconnect toasts after the initial rehydration settles.
  useEffect(() => {
    const id = setTimeout(() => {
      armed.current = true;
    }, 1500);
    return () => clearTimeout(id);
  }, []);

  // Wallet connect / disconnect.
  useEffect(() => {
    const prev = prevConnected.current;
    prevConnected.current = connected;
    if (prev === null || prev === connected || !armed.current) return;
    if (connected) {
      toast({
        variant: "success",
        mood: "cool",
        title: "Wallet connected",
        message: "Pip’s glad you’re here. Happy swapping!",
      });
    } else {
      toast({
        variant: "info",
        mood: "wave",
        title: "Wallet disconnected",
        message: "Come back soon. Pip’s tending the gardens.",
      });
    }
  }, [connected, toast]);

  // Wrong-network watch (only meaningful once connected and the id is known).
  useEffect(() => {
    if (!connected || networkId === undefined) {
      prevMismatch.current = null;
      return;
    }
    const mismatch = networkId !== APP_CONFIG.networkId;
    const prev = prevMismatch.current;
    prevMismatch.current = mismatch;
    if (prev === mismatch) return; // no transition (prev null counts as a change)

    if (mismatch) {
      const walletNet = networkId === 1 ? "Mainnet" : "a testnet";
      toast({
        variant: "danger",
        mood: "worried",
        title: "Wrong network",
        message: `Your wallet’s on ${walletNet}, but ShaSwap lives on ${networkLabel()}. Switch networks in your wallet.`,
        duration: 8000,
      });
    } else if (prev === true) {
      toast({
        variant: "success",
        mood: "love",
        title: `Back on ${networkLabel()}`,
        message: "You’re all set.",
      });
    }
  }, [connected, networkId, toast]);

  return null;
}
