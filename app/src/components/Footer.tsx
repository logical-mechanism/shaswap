import { APP_CONFIG, networkLabel } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t border-white/5 py-5 text-center text-xs text-muted">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-2 px-4 sm:flex-row sm:px-6">
        <span>
          ShaSwap — a non-custodial, MEV-resistant batch-auction DEX on Cardano.
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          {networkLabel()}
          {APP_CONFIG.network !== "mainnet" && " · testnet"}
          <span className="sr-only">network {APP_CONFIG.network}</span>
        </span>
      </div>
    </footer>
  );
}
