import type { ReactNode } from "react";
import { Pip, type PipMood } from "./Pip";

/**
 * One shared empty/dead-end state so Pip greets the user consistently wherever there's
 * nothing (yet) to show — replaces the ad-hoc `Empty()` copies that had drifted across
 * the Orders, Pools, and Swap pages (each with a slightly different size/mood/layout).
 *
 * `mood` carries the meaning: `sleepy` for an inviting nothing-here-yet ("drop the first
 * one off"), `thinking` for an informational dead-end ("no pair matches that"). Pass a
 * CTA via `children`.
 */
export function PipEmptyState({
  mood = "sleepy",
  title,
  body,
  size = 60,
  children,
  className = "",
}: {
  mood?: PipMood;
  /** Optional headline above the body. */
  title?: string;
  body: ReactNode;
  size?: number;
  /** A call-to-action (button/link) shown under the body. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`k-card flex flex-col items-center px-4 py-12 text-center ${className}`}
    >
      <Pip size={size} mood={mood} />
      {title && (
        <div className="mt-3 font-display text-lg font-extrabold text-ink">{title}</div>
      )}
      <p className={`${title ? "mt-1" : "mt-3"} max-w-xs text-sm text-muted`}>{body}</p>
      {children}
    </div>
  );
}
