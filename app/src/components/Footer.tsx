import { APP_CONFIG, networkLabel } from "@/lib/config";
import { Pip } from "@/components/Pip";

export function Footer() {
  return (
    <footer className="border-t border-border py-5 text-center text-xs text-muted">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-2 px-4 sm:flex-row sm:px-6">
        <span>
          ShaSwap — a cozy, fair batch-auction hut on Cardano. Your keys, your coins.
        </span>
        <span className="k-pill text-xs">
          <Pip size={18} mood="happy" />
          {networkLabel()}
          {APP_CONFIG.network !== "mainnet" && " · testnet"}
          <span className="sr-only">network {APP_CONFIG.network}</span>
        </span>
      </div>
    </footer>
  );
}
