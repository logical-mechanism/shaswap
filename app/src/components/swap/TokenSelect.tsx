"use client";

import type { TokenInfo } from "@/lib/data";
import { useMenu } from "@/hooks/useMenu";

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
  const { open, setOpen, containerRef, triggerRef } = useMenu();

  const options = tokens.filter((t) => t.unit !== exclude);

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Select token${token ? ` (current: ${token.ticker})` : ""}`}
        className="k-pill shrink-0 py-1.5 pl-1.5 pr-3 text-sm font-semibold"
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
        <div
          role="listbox"
          aria-label="Tokens"
          className="k-pop absolute right-0 z-30 mt-2 w-52 overflow-hidden"
        >
          {options.map((t) => (
            <button
              key={t.unit}
              type="button"
              role="option"
              aria-selected={t.unit === token?.unit}
              onClick={() => {
                onSelect(t);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-sunk"
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
  // ADA gets its own mark: the ₳ symbol on Cardano blue, not gradient initials.
  if (token?.unit === "lovelace") {
    return (
      <span
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#0033ad] text-[13px] font-bold text-white"
        aria-hidden
      >
        ₳
      </span>
    );
  }
  // Real registry logo (a data-URI) as a background — avoids next/image config and
  // the no-img-element rule, and degrades to the gradient initials when absent.
  if (token?.icon) {
    return (
      <span
        className="h-6 w-6 shrink-0 rounded-full bg-surface-sunk bg-cover bg-center"
        style={{ backgroundImage: `url("${token.icon}")` }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-pink to-lavender text-[10px] font-bold text-white"
      aria-hidden
    >
      {token?.ticker?.slice(0, 2) ?? "?"}
    </span>
  );
}
