"use client";

import {
  useAddress,
  useLovelace,
  useNetwork,
  useWallet,
  useWalletList,
} from "@meshsdk/react";
import { APP_CONFIG, networkLabel } from "@/lib/config";
import { formatAda, truncate } from "@/lib/format";
import { useMenu } from "@/hooks/useMenu";
import { Pip } from "./Pip";

/**
 * Header wallet area — fully branded (no default Mesh modal). Disconnected: a
 * "Connect wallet" pill opens a kawaii wallet picker built from `useWalletList()`.
 * Connected: a status pill (network · balance · address) opens a small menu with
 * the wallet name and a Disconnect action. All wallet state comes from MeshProvider.
 */
export function WalletBar() {
  const { connected } = useWallet();
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {connected ? <ConnectedMenu /> : <ConnectMenu />}
    </div>
  );
}

function ConnectMenu() {
  const { connect, connecting } = useWallet();
  const wallets = useWalletList();
  const { open, setOpen, containerRef, triggerRef } = useMenu();

  async function pick(walletName: string) {
    setOpen(false);
    try {
      await connect(walletName, true);
    } catch {
      // user declined / wallet errored — Mesh keeps us disconnected; nothing to do.
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={connecting}
        aria-haspopup="menu"
        aria-expanded={open}
        className="k-btn px-4 py-2 text-sm"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>

      {open && (
        <div className="k-pop animate-pop absolute right-0 z-40 mt-2 w-64 p-2">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Pip size={28} mood="wave" />
            <span className="font-display text-sm font-extrabold text-ink">
              Pick your wallet
            </span>
          </div>
          {wallets.length === 0 ? (
            <p className="px-2 py-2 text-xs leading-relaxed text-muted">
              Pip can’t find a Cardano wallet. Install one (like Eternl, Lace, or
              Nami), then refresh the page.
            </p>
          ) : (
            <div className="mt-1 space-y-1">
              {wallets.map((w) => (
                <button
                  key={w.name}
                  type="button"
                  onClick={() => pick(w.name)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-sunk"
                >
                  <WalletIcon icon={w.icon} name={w.name} />
                  <span className="text-sm font-semibold capitalize text-ink">
                    {w.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectedMenu() {
  const { disconnect, name } = useWallet();
  const address = useAddress();
  const lovelace = useLovelace();
  const networkId = useNetwork();
  const { open, setOpen, containerRef, triggerRef } = useMenu();

  const mismatch =
    networkId !== undefined && networkId !== APP_CONFIG.networkId;

  if (!address) {
    // Connected but address not resolved yet — show a calm placeholder pill.
    return (
      <span className="k-pill text-xs text-muted">
        <Pip size={18} mood="thinking" />
        Loading…
      </span>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={mismatch ? "Wallet network differs from app network" : undefined}
        className="flex items-center gap-2 rounded-full border border-border bg-surface py-1.5 pl-2.5 pr-2 text-sm transition-colors hover:border-accent/40"
      >
        <span className={`k-chip ${mismatch ? "k-chip-danger" : "k-chip-accent"}`}>
          {mismatch ? "Wrong network" : networkLabel()}
        </span>
        <span className="hidden tabular-nums text-muted sm:inline">
          {formatAda(lovelace)} ₳
        </span>
        <span className="rounded-full bg-surface-sunk px-2.5 py-1 font-mono text-xs text-muted">
          {truncate(address)}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path
            d="M2.5 4.5L6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="sr-only">network {APP_CONFIG.network}</span>
      </button>

      {open && (
        <div className="k-pop animate-pop absolute right-0 z-40 mt-2 w-60 p-2">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <Pip size={26} mood="cool" />
            <span className="font-display text-sm font-extrabold capitalize text-ink">
              {name ?? "Wallet"}
            </span>
          </div>
          <div className="break-all px-2 pb-1.5 font-mono text-[11px] text-muted">
            {address}
          </div>
          <div className="flex items-center justify-between px-2 pb-2 text-xs text-muted">
            <span>Balance</span>
            <span className="tabular-nums">{formatAda(lovelace)} ₳</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
            className="k-btn-ghost w-full justify-center py-2 text-sm"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function WalletIcon({ icon, name }: { icon?: string; name: string }) {
  if (icon) {
    return (
      <span
        className="h-6 w-6 shrink-0 rounded-full bg-surface-sunk bg-contain bg-center bg-no-repeat"
        style={{ backgroundImage: `url("${icon}")` }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-pink to-lavender text-[10px] font-bold text-white"
      aria-hidden
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
