"use client";

import { useState } from "react";
import type { ReactNode } from "react";

/**
 * A small, on-brand collapsible. The trigger is a soft ghost pill with a chevron;
 * the content slides/pops in below. Presentation only — caller supplies the
 * summary label and the body.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  align = "center",
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  align?: "center" | "start";
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={`flex flex-col ${align === "center" ? "items-center" : "items-start"} ${className}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="k-btn-ghost px-4 py-2 text-xs font-bold text-muted"
      >
        <span>{summary}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path
            d="M2.5 4.5L6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && <div className="animate-pop mt-3 w-full">{children}</div>}
    </div>
  );
}
