"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Pip } from "@/components/Pip";
import { reloadOnceOnChunkError } from "@/lib/client/chunkError";

/**
 * Branded route-level error boundary. Catches a render/runtime error in any page under
 * the root layout and offers a recovery (`reset()`) instead of Next.js's stock screen.
 * The real error is logged for observability; the user sees a friendly, non-leaky note.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A stale/failed code-split chunk (often an old tab after a redeploy) self-heals on a
    // one-time reload; if that fires, the document is replaced — skip the rest.
    if (reloadOnceOnChunkError(error)) return;
    console.error("[app] route error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="k-card flex flex-col items-center px-6 py-12">
        <Pip size={72} mood="worried" />
        <h1 className="mt-4 font-display text-2xl font-extrabold text-ink">
          Something tripped Pip up
        </h1>
        <p className="mt-2 max-w-xs text-sm text-muted">
          A snag loading this page — usually momentary. Your funds are never
          affected (everything lives on-chain).
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button type="button" onClick={reset} className="k-btn px-5 py-2.5 text-sm">
            Try again
          </button>
          <Link href="/" className="k-btn-ghost px-5 py-2.5 text-sm">
            Back to Swap
          </Link>
        </div>
      </div>
    </div>
  );
}
