"use client";

import { useEffect, useRef, useState } from "react";
import type { TokenInfo } from "@/lib/data";

/** Token chip + dropdown. Presentation only — selecting just sets state. */
export function TokenSelect({
  token,
  tokens,
  exclude,
  onSelect,
}: {
  token: TokenInfo | undefined;
  tokens: TokenInfo[];
  exclude?: string;
  onSelect: (t: TokenInfo) => void;
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

  const options = tokens.filter((t) => t.unit !== exclude);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1.5 pl-1.5 pr-3 text-sm font-semibold transition-colors hover:bg-white/10"
      >
        <TokenIcon token={token} />
        <span>{token?.ticker ?? "Select"}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path
            d="M2.5 4.5L6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-xl border border-white/10 bg-surface shadow-xl">
          {options.map((t) => (
            <button
              key={t.unit}
              type="button"
              onClick={() => {
                onSelect(t);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/5"
            >
              <TokenIcon token={t} />
              <span className="flex flex-col">
                <span className="font-semibold">{t.ticker}</span>
                <span className="text-xs text-muted">{t.name}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenIcon({ token }: { token: TokenInfo | undefined }) {
  return (
    <span
      className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-accent/80 to-accent-2/80 text-[10px] font-bold text-black"
      aria-hidden
    >
      {token?.ticker?.slice(0, 2) ?? "?"}
    </span>
  );
}
