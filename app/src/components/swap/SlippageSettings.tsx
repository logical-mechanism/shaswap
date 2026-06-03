"use client";

import { useEffect, useRef, useState } from "react";

const PRESETS = [0.1, 0.5, 1.0];

/**
 * Slippage settings affordance. The value is NOT cosmetic — it sets an enforced minimum:
 *  - swap: the per-order **floor** (`floor = estimatedOut × (1 − slippage)`), serialized
 *    into the OrderDatum, bounding the worst fill the solver may settle at;
 *  - liquidity: the **minimum amounts out** (min-LP-received on deposit, min token amounts
 *    on withdraw) the tx will accept if the pool moves before it confirms.
 * `context` makes the helper copy match the flow it's used in.
 */
export function SlippageSettings({
  value,
  onChange,
  context = "swap",
}: {
  value: number;
  onChange: (v: number) => void;
  context?: "swap" | "liquidity";
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
        className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors hover:bg-surface-sunk hover:text-accent"
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
        <div className="absolute right-0 z-30 mt-2 w-60 rounded-2xl border border-border bg-surface p-3 shadow-[0_24px_50px_-28px_rgba(150,110,190,0.5)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">Max slippage</span>
            <span className="k-chip k-chip-muted text-[10px]">
              {context === "liquidity" ? "sets your minimum out" : "sets your floor"}
            </span>
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(p)}
                className={`flex-1 rounded-full border px-2 py-1.5 text-xs transition-colors ${
                  value === p
                    ? "border-accent/40 bg-accent/15 font-bold text-accent"
                    : "border-border text-muted hover:bg-surface-sunk"
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
