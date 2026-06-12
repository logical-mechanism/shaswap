"use client";

import { useEffect } from "react";
import { Pip } from "@/components/Pip";

// How many overlays are currently signing. The data-signing flag is page-wide (it pauses
// decorative motion everywhere), so ref-count it: the LAST overlay to close clears it, not
// the first — robust if two overlays are ever open at once.
let signingCount = 0;

/**
 * A blocking "Pip is working" overlay for transaction flows. It covers the gap between
 * clicking an action (post / reclaim / deposit / withdraw / create / close) and the
 * wallet's signing popup appearing: MeshSDK loads and the tx builds for a beat, during
 * which only a button label would otherwise change. Non-dismissable — it clears when the
 * flow resolves (success or error). One reusable component; each flow passes its own copy.
 *
 * This is the SIGNING moment, so it is deliberately CALM (brand rule: no heavy animation
 * during signing). Pip stands `still` — no bob, no sparkles, no overlay twinkles — even for
 * users without prefers-reduced-motion, and while it's open it sets `data-signing` on the
 * document so the ambient backdrop decoration stops moving too (see globals.css). The only
 * motion is the card's one-shot scale-in. Calming this one shared component calms every
 * write flow at once.
 */
export function PipOverlay({
  show,
  title,
  subtitle = "Your wallet will ask you to confirm. Pip can’t move your funds, only you can.",
}: {
  show: boolean;
  title: string;
  /** The line under the title; defaults to a calm, non-custodial wallet-confirm nudge. */
  subtitle?: string;
}) {
  // While the overlay is up, quiet the whole stage: a root flag pauses the ambient
  // backdrop's float/twinkle so nothing drifts behind the signing prompt. Cleaned up on
  // hide/unmount so motion resumes the moment the flow resolves.
  useEffect(() => {
    if (!show) return;
    signingCount += 1;
    document.documentElement.dataset.signing = "true";
    return () => {
      signingCount = Math.max(0, signingCount - 1);
      if (signingCount === 0) delete document.documentElement.dataset.signing;
    };
  }, [show]);

  if (!show) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="k-card animate-pop flex max-w-xs flex-col items-center gap-3 p-6 text-center">
        <Pip size={64} mood="calm" still />
        <div className="font-display text-lg font-extrabold text-ink">{title}</div>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
