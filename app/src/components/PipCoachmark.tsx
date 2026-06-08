"use client";

import { useEffect, useState } from "react";
import { Pip, type PipMood } from "./Pip";

/**
 * A one-time, dismissible Pip speech bubble — Pip leans in and says one warm, plain thing
 * to a first-time user, then never again (the dismissal is remembered in localStorage by
 * `id`). Deliberately rationed: show at most one of these on a screen so Pip guides without
 * nagging. Never use it on signing/warning/error surfaces — those stay calm and motion-free.
 *
 * Renders nothing until mounted (so SSR and the persisted "seen" flag agree, no flash), and
 * nothing once dismissed.
 */
const PREFIX = "shaswap-coach-";

export function PipCoachmark({
  id,
  children,
  mood = "wave",
  className = "",
}: {
  /** Stable key for this coachmark; its dismissal is remembered under this id. */
  id: string;
  children: React.ReactNode;
  mood?: PipMood;
  className?: string;
}) {
  const [show, setShow] = useState(false);

  // Defer the read + setState out of the effect body (project convention: no synchronous
  // setState in an effect — it triggers cascading renders).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (localStorage.getItem(PREFIX + id) !== "seen") setShow(true);
      } catch {
        // private mode / storage blocked — still show it once this session.
        setShow(true);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [id]);

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(PREFIX + id, "seen");
    } catch {
      // best-effort; if storage is blocked it simply reappears next mount.
    }
  }

  if (!show) return null;

  return (
    <div className={`flex items-start gap-2 ${className}`} role="note">
      <Pip size={42} mood={mood} float className="shrink-0" />
      <div className="k-bubble k-bubble-l relative flex-1 p-3 pr-9 text-xs leading-relaxed text-foreground">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss Pip's tip"
          className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-sunk hover:text-ink"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M2.5 2.5l7 7m0-7l-7 7"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div>{children}</div>
        <button type="button" onClick={dismiss} className="k-link mt-1.5 inline-block">
          Got it
        </button>
      </div>
    </div>
  );
}
