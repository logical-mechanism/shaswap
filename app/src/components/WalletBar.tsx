"use client";

import { CardanoWallet, useAddress, useLovelace, useNetwork, useWallet } from "@meshsdk/react";
import { APP_CONFIG, networkLabel } from "@/lib/config";
import { formatAda, truncate } from "@/lib/format";

/**
 * Header wallet area: a status pill (network · ADA balance · address) shown when
 * connected, plus MeshJS's `CardanoWallet` connect button. No login — connect
 * and go. All wallet state comes from MeshProvider via the hooks.
 */
export function WalletBar() {
  const { connected } = useWallet();
  const address = useAddress();
  const lovelace = useLovelace();
  const networkId = useNetwork();

  // Flag if the connected wallet's network doesn't match the app's target.
  const mismatch =
    connected && networkId !== undefined && networkId !== APP_CONFIG.networkId;

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {connected && address && (
        <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1.5 pl-3 pr-1.5 text-sm sm:flex">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              mismatch
                ? "bg-red-500/15 text-red-300"
                : "bg-accent/15 text-accent"
            }`}
            title={mismatch ? "Wallet network differs from app network" : undefined}
          >
            {mismatch ? "Wrong network" : networkLabel()}
          </span>
          <span className="tabular-nums text-muted">
            {formatAda(lovelace)} ₳
          </span>
          <span className="rounded-full bg-black/30 px-2.5 py-1 font-mono text-xs text-muted">
            {truncate(address)}
          </span>
        </div>
      )}
      <CardanoWallet
        label="Connect wallet"
        isDark
        persist
      />
    </div>
  );
}
