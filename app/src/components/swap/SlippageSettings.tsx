"use client";

import { useEffect, useRef, useState } from "react";

const PRESETS = [0.1, 0.5, 1.0];

/**
 * Slippage settings affordance — VISUAL ONLY. It surfaces the control the real
 * swap flow will need, but in the skeleton it just stores a local number and
 * affects nothing on-chain.
 */
export function SlippageSettings({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Slippage settings"
        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M8 10.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
          />
          <path
            d="M8 1.5v1.6M8 12.9v1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M1.5 8h1.6M12.9 8h1.6M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-white/10 bg-surface p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">Max slippage</span>
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">
              visual only
            </span>
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(p)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                  value === p
                    ? "border-accent/40 bg-accent/15 text-accent"
                    : "border-white/10 text-muted hover:bg-white/5"
                }`}
              >
                {p.toFixed(1)}%
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
