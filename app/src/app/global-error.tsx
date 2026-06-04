"use client";

import { useEffect } from "react";
import { Pip } from "@/components/Pip";
import { reloadOnceOnChunkError } from "@/lib/client/chunkError";

/**
 * Last-resort boundary for an error thrown in the ROOT layout itself. It replaces the
 * whole document (Next.js renders it instead of layout.tsx), so it must ship its own
 * <html>/<body> and can't rely on globals.css/Tailwind — hence inline styles. Pip is
 * pure inline SVG, so it still renders on-brand here.
 */
export default function GlobalError({
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
    console.error("[app] global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          textAlign: "center",
          color: "#4a3a5a",
          background:
            "linear-gradient(180deg, #fff6fc 0%, #fdf2fb 45%, #f7f0fe 100%)",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 380 }}>
          <Pip size={84} mood="worried" />
          <div
            style={{ fontSize: 30, fontWeight: 800, marginTop: 12, color: "#362946" }}
          >
            ShaSwap hit a snag
          </div>
          <p style={{ margin: "8px auto 20px", lineHeight: 1.5 }}>
            Something unexpected happened. Reloading usually clears it — and your funds
            are safe on-chain regardless.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              border: 0,
              borderRadius: 999,
              padding: "0.8rem 1.5rem",
              fontSize: 14,
              fontWeight: 800,
              color: "#fff",
              cursor: "pointer",
              background: "linear-gradient(135deg, #e8458f 0%, #a98bf0 100%)",
              boxShadow: "0 14px 26px -12px rgba(232,69,143,0.65)",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
