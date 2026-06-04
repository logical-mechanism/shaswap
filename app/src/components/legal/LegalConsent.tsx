"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { LEGAL } from "@/lib/legal/config";
import { Pip } from "@/components/Pip";

/**
 * Pre-connect legal click-through — the one piece of "compliance UX" we mirror from
 * SundaeSwap: a user must accept the Terms + Privacy Policy before a wallet can be
 * connected. Nothing here screens, geofences, or blocks; it is a consent record only,
 * and it never touches the user's ability to RECLAIM funds (accepting is a single
 * checkbox, not a screening gate).
 *
 * Acceptance is stored in `localStorage` keyed to `LEGAL.version`, so bumping the
 * terms version (in `lib/legal/config.ts`) re-prompts everyone — the fix for the
 * stale-2021-click-through problem SundaeSwap has.
 */

const STORAGE_KEY = "shaswap.legal";

interface LegalConsentValue {
  /**
   * Run `onConsent` once the user has accepted the current terms. If they already
   * have, it runs immediately; otherwise the gate opens and it runs on acceptance
   * (or is dropped if they cancel). Use this to wrap wallet-connect.
   */
  requireConsent: (onConsent: () => void) => void;
}

const LegalConsentContext = createContext<LegalConsentValue | null>(null);

export function useLegalConsent(): LegalConsentValue {
  const ctx = useContext(LegalConsentContext);
  if (!ctx) {
    throw new Error("useLegalConsent must be used within <LegalConsentProvider>");
  }
  return ctx;
}

/** Read persisted acceptance for the CURRENT terms version (client-only; safe in handlers). */
function hasAccepted(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version === LEGAL.version;
  } catch {
    return false;
  }
}

export function LegalConsentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);

  const requireConsent = useCallback((onConsent: () => void) => {
    // Checked live (not from render state) so it's correct even if another tab accepted.
    if (hasAccepted()) {
      onConsent();
      return;
    }
    pending.current = onConsent;
    setOpen(true);
  }, []);

  const accept = useCallback(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: LEGAL.version, ts: new Date().toISOString() }),
      );
    } catch {
      // Private-mode / storage-blocked: still let them through for this session
      // (the pending action runs below); they'll simply be re-prompted next visit.
    }
    setOpen(false);
    const cb = pending.current;
    pending.current = null;
    cb?.();
  }, []);

  const dismiss = useCallback(() => {
    pending.current = null;
    setOpen(false);
  }, []);

  const value = useMemo(() => ({ requireConsent }), [requireConsent]);

  return (
    <LegalConsentContext.Provider value={value}>
      {children}
      {/* Mounted only while open, so the gate's local state (checkbox) resets each time. */}
      {open && <LegalGate onAccept={accept} onDismiss={dismiss} />}
    </LegalConsentContext.Provider>
  );
}

function LegalGate({
  onAccept,
  onDismiss,
}: {
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);

  // On mount (= when the gate opens): move focus in, lock body scroll, and close on
  // Escape (matching the app's other poppers, see useMenu). Cleanup runs on unmount.
  useEffect(() => {
    const t = setTimeout(() => checkboxRef.current?.focus(), 0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      // Backdrop click cancels (same as Escape / Not now) — it only aborts connecting.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-gate-title"
        className="k-card animate-pop flex w-full max-w-sm flex-col items-center gap-3 p-6 text-center"
      >
        <Pip size={56} mood="wave" />
        <h2
          id="legal-gate-title"
          className="font-display text-lg font-extrabold text-ink"
        >
          One quick thing
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {LEGAL.protocol} is non-custodial software for an immutable protocol on
          Cardano. You keep your keys and your coins. Please review and accept before
          connecting a wallet.
        </p>

        <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-xl bg-surface-sunk px-3 py-2.5 text-left text-sm text-ink">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          <span className="leading-snug">
            I have read and agree to the{" "}
            <Link
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="k-link"
            >
              Terms
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="k-link"
            >
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        <div className="mt-2 flex w-full gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="k-btn-ghost flex-1 justify-center py-2 text-sm"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={!checked}
            className="k-btn flex-1 py-2 text-sm"
          >
            Agree &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}
