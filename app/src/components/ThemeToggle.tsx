"use client";

import { useEffect, useState } from "react";

/**
 * Light ⇄ "cozy night" toggle. The actual class is applied to <html> by the inline
 * no-FOUC script in the root layout (which reads localStorage / system preference
 * before paint); this button just flips it and remembers the choice.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  // Read the theme the no-FOUC script already settled on (after mount, so SSR and
  // first client render agree — then we sync the icon to reality). Deferred out of
  // the effect body per the project's effect convention (no synchronous setState).
  useEffect(() => {
    const id = setTimeout(() => {
      setDark(document.documentElement.classList.contains("dark"));
    }, 0);
    return () => clearTimeout(id);
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("shaswap-theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable (private mode) — toggle still works for the session */
    }
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to daylight" : "Switch to cozy night"}
      title={dark ? "Switch to daylight" : "Switch to cozy night"}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border bg-surface text-accent transition-colors hover:border-accent/40 hover:text-accent-2"
    >
      {dark ? (
        // sun
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="3.1" fill="currentColor" />
          <g
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          >
            <path d="M8 1.3v1.7M8 13v1.7M1.3 8h1.7M13 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2" />
          </g>
        </svg>
      ) : (
        // crescent moon
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M13.4 9.6A5.4 5.4 0 116.6 2.7a4.2 4.2 0 106.8 6.9Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}
