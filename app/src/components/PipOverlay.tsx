"use client";

import { Pip } from "@/components/Pip";

/**
 * A blocking "Pip is working" overlay for transaction flows. It covers the gap between
 * clicking an action (post / reclaim / deposit / withdraw / create / close) and the
 * wallet's signing popup appearing: MeshSDK loads and the tx builds for a beat, during
 * which only a button label would otherwise change. Non-dismissable — it clears when the
 * flow resolves (success or error). One reusable component; each flow passes its own copy.
 */
export function PipOverlay({
  show,
  title,
  subtitle = "Confirm the transaction in your wallet.",
}: {
  show: boolean;
  title: string;
  /** The line under the title; defaults to the wallet-confirm nudge every tx flow needs. */
  subtitle?: string;
}) {
  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="k-card animate-pop flex max-w-xs flex-col items-center gap-3 p-6 text-center">
        <Pip size={64} mood="thinking" float sparkles />
        <div className="font-display text-lg font-extrabold text-ink">{title}</div>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
