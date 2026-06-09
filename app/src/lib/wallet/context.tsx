"use client";

import dynamic from "next/dynamic";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
// Type-only — erased at build, so this file pulls NO @meshsdk runtime (no core-cst).
import type { Asset, IWallet } from "@meshsdk/core";

/**
 * Mesh-free wallet state for the whole app.
 *
 * The entire `@meshsdk` wallet stack (`@meshsdk/react` → `@meshsdk/wallet` →
 * `@meshsdk/core-cst`, a ~7.5MB WASM bundle whose instantiation blocks the main thread
 * for seconds) is the single heaviest thing the app loads. To keep it off the initial
 * load entirely — so the page paints, hydrates, and settles with zero wallet code — the
 * real Mesh hooks live ONLY inside a dynamically-imported bridge (`MeshBridge`) that this
 * provider mounts on demand.
 *
 * Components never import `@meshsdk/react`; they read wallet state through `useAppWallet`
 * (or the drop-in compat hooks in `./hooks`). Before the bridge loads, that state is a
 * static disconnected default; once loaded, the bridge streams real Mesh state in via
 * `onState`. No re-mount of the app tree — only a context value update.
 *
 * The bridge is loaded on the user's FIRST interaction (or an explicit Connect), never on
 * mount — so an automated page load (e.g. Lighthouse) never triggers the WASM, while a
 * real user's persisted wallet reconnects the instant they touch the page.
 */

export interface WalletInfo {
  name: string;
  icon?: string;
  version?: string;
}

export interface AppWalletState {
  /** True once the Mesh bridge has loaded and reported in. */
  ready: boolean;
  connected: boolean;
  connecting: boolean;
  name?: string;
  wallet?: IWallet;
  address?: string;
  lovelace?: string;
  assets?: Asset[];
  networkId?: number;
  walletList: WalletInfo[];
}

export interface BridgeActions {
  connect: (name: string, persist?: boolean) => Promise<void>;
  disconnect: () => void;
  /** Re-read the connected wallet's balance/assets (event-driven; no polling). */
  refresh: () => void;
}

export interface AppWalletValue extends AppWalletState {
  /** Start loading the Mesh stack (idempotent). Safe to call from a click handler. */
  ensureLoaded: () => void;
  connect: (name: string, persist?: boolean) => Promise<void>;
  disconnect: () => void;
  /**
   * Re-read the connected wallet's balance/assets right now — call after submitting a tx so
   * the shown balance updates without polling. No-op until the wallet bridge has loaded.
   */
  refresh: () => void;
}

const DISCONNECTED: AppWalletState = {
  ready: false,
  connected: false,
  connecting: false,
  name: undefined,
  wallet: undefined,
  address: undefined,
  lovelace: undefined,
  assets: undefined,
  networkId: undefined,
  walletList: [],
};

const AppWalletContext = createContext<AppWalletValue | null>(null);

export function useAppWallet(): AppWalletValue {
  const ctx = useContext(AppWalletContext);
  if (!ctx) {
    throw new Error("useAppWallet must be used within <AppWalletProvider>");
  }
  return ctx;
}

// The bridge statically imports @meshsdk/react (→ core-cst). It is ONLY ever rendered
// once `phase` leaves "idle", so this dynamic import is the seam that keeps the WASM out
// of the initial bundle. ssr:false: wallet code is browser-only.
const MeshBridge = dynamic(() => import("@/components/wallet/MeshBridge"), {
  ssr: false,
});

export function AppWalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppWalletState>(DISCONNECTED);
  const [phase, setPhase] = useState<"idle" | "loading">("idle");
  const actionsRef = useRef<BridgeActions | null>(null);
  const pendingConnect = useRef<{ name: string; persist: boolean } | null>(null);

  const ensureLoaded = useCallback(() => {
    setPhase((p) => (p === "idle" ? "loading" : p));
  }, []);

  // Load the wallet stack on the user's FIRST interaction (never on mount): a persisted
  // wallet then reconnects the moment they touch the page, while an automated/headless
  // load that never interacts stays completely wallet-free. Intentful events only
  // (pointer/key/touch) — deliberately NOT scroll/idle, which a Lighthouse run can fire.
  useEffect(() => {
    const trigger = () => ensureLoaded();
    const opts = { once: true, passive: true } as const;
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, trigger, opts);
    return () => {
      for (const e of events) window.removeEventListener(e, trigger);
    };
  }, [ensureLoaded]);

  const registerActions = useCallback((actions: BridgeActions) => {
    actionsRef.current = actions;
    const pend = pendingConnect.current;
    if (pend) {
      pendingConnect.current = null;
      void actions.connect(pend.name, pend.persist);
    }
  }, []);

  const onState = useCallback((next: AppWalletState) => {
    setState(next);
  }, []);

  const connect = useCallback(
    async (name: string, persist = true) => {
      if (actionsRef.current) {
        return actionsRef.current.connect(name, persist);
      }
      // Bridge not ready yet — queue the connect and kick off the load; registerActions
      // flushes the pending connect the moment the bridge mounts.
      pendingConnect.current = { name, persist };
      ensureLoaded();
    },
    [ensureLoaded],
  );

  const disconnect = useCallback(() => {
    actionsRef.current?.disconnect();
  }, []);

  const refresh = useCallback(() => {
    actionsRef.current?.refresh();
  }, []);

  const value = useMemo<AppWalletValue>(
    () => ({ ...state, ensureLoaded, connect, disconnect, refresh }),
    [state, ensureLoaded, connect, disconnect, refresh],
  );

  return (
    <AppWalletContext.Provider value={value}>
      {children}
      {phase !== "idle" && (
        <MeshBridge onState={onState} registerActions={registerActions} />
      )}
    </AppWalletContext.Provider>
  );
}
