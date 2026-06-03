"use client";

import { useState } from "react";
import { useMenu } from "@/hooks/useMenu";

const PRESETS = [0.1, 0.5, 1.0];
const MAX_SLIPPAGE = 50; // hard clamp — beyond this the floor is meaningless

/**
 * Slippage settings affordance. The value is NOT cosmetic — it sets an enforced minimum:
 *  - swap: the per-order **floor** (`floor = estimatedOut × (1 − slippage)`), serialized
 *    into the OrderDatum, bounding the worst fill the solver may settle at;
 *  - liquidity: the **minimum amounts out** (min-LP-received on deposit, min token amounts
 *    on withdraw) the tx will accept if the pool moves before it confirms.
 * `context` makes the helper copy match the flow it's used in.
 *
 * Presets cover the common cases; a custom field lets the user widen tolerance when the
 * pool is shallow (the swap card warns about high price impact), with a caution above 5%.
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
  const { open, setOpen, containerRef, triggerRef } = useMenu();
  const [custom, setCustom] = useState(() =>
    PRESETS.includes(value) ? "" : String(value),
  );
  const customActive = custom !== "";

  function pickPreset(p: number) {
    setCustom("");
    onChange(p);
  }
  function onCustom(v: string) {
    if (v !== "" && !/^\d*\.?\d*$/.test(v)) return;
    setCustom(v);
    const n = Number(v);
    if (v !== "" && Number.isFinite(n)) {
      onChange(Math.min(MAX_SLIPPAGE, Math.max(0, n)));
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Slippage settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-surface-sunk hover:text-accent"
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
        <div
          role="dialog"
          aria-label="Max slippage"
          className="k-pop absolute right-0 z-30 mt-2 w-64 p-3"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium">Max slippage</span>
            <span className="k-chip k-chip-muted text-[10px]">
              {context === "liquidity" ? "sets your minimum out" : "sets your floor"}
            </span>
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map((p) => {
              const active = !customActive && value === p;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickPreset(p)}
                  className={`flex-1 rounded-full border px-2 py-1.5 text-xs transition-colors ${
                    active
                      ? "k-toggle-active border-accent/40 font-bold"
                      : "border-border text-muted hover:bg-surface-sunk"
                  }`}
                >
                  {p.toFixed(1)}%
                </button>
              );
            })}
          </div>

          <label className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-muted">Custom</span>
            <span
              className={`k-input-box flex flex-1 items-center gap-1 px-2 py-1 ${
                customActive ? "border-accent/50" : ""
              }`}
            >
              <input
                inputMode="decimal"
                value={custom}
                placeholder="e.g. 2.5"
                onChange={(e) => onCustom(e.target.value)}
                aria-label="Custom max slippage percent"
                className="k-input text-right text-xs tabular-nums"
              />
              <span className="text-xs text-muted">%</span>
            </span>
          </label>

          {value > 5 && (
            <p className="mt-2 text-[11px] font-semibold text-warning">
              High tolerance — you could accept a noticeably worse fill.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
