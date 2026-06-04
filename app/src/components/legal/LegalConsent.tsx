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
import { useWallet } from "@meshsdk/react";
import { LEGAL } from "@/lib/legal/config";
import { Pip } from "@/components/Pip";

/**
 * Pre-connect legal click-through — the one piece of "compliance UX" we mirror from
 * SundaeSwap: a user must accept the Terms + Privacy Policy before a wallet can be
 * connected. Nothing here screens, geofences, or blocks; it is a consent record only.
 *
 * Acceptance is stored in `localStorage` keyed to `LEGAL.version`, so bumping the
 * terms version (in `lib/legal/config.ts`) re-prompts everyone — the fix for the
 * stale-2021-click-through problem SundaeSwap has. A persisted wallet that
 * auto-reconnects past the gate is reconciled on mount (see the effect below), so the
 * re-prompt actually reaches already-connected users too.
 */

const STORAGE_KEY = "shaswap.legal";

interface LegalConsentValue {
  /**
   * Run `onConsent` once the user has accepted the current terms. If they already
   * have, it runs immediately; otherwise the gate opens and it runs on acceptance
   * (or is dropped if they cancel). Use this to wrap wallet-connect.
   *
   * Single-consent gate: it serves ONE pending action at a time. Today the sole
   * caller is the wallet-connect button; if a second gated action is ever added,
   * give the gate a queue rather than letting a second call overwrite the first.
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

/** Read PERSISTED acceptance for the current terms version (client-only; safe in handlers). */
function persistedAcceptance(): boolean {
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
  const { connected, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  // In-memory fallback: a session where localStorage is blocked (Safari private mode,
  // quota) still counts as accepted, so the user isn't re-prompted on every connect.
  const acceptedThisSession = useRef(false);

  const isAccepted = useCallback(
    () => acceptedThisSession.current || persistedAcceptance(),
    [],
  );

  const requireConsent = useCallback(
    (onConsent: () => void) => {
      if (isAccepted()) {
        onConsent();
        return;
      }
      pending.current = onConsent;
      setOpen(true);
    },
    [isAccepted],
  );

  const accept = useCallback(() => {
    acceptedThisSession.current = true;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: LEGAL.version, ts: new Date().toISOString() }),
      );
    } catch {
      // Storage blocked: the in-memory flag above carries consent for this session.
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

  // A persisted wallet auto-reconnects on load WITHOUT passing the connect gate, and a
  // LEGAL.version bump won't re-prompt an already-connected user (they render the
  // connected menu, not the gated connect button). So if we're connected while the
  // current terms are unaccepted, disconnect — the next connect must pass the gate.
  useEffect(() => {
    if (connected && !isAccepted()) {
      disconnect();
    }
  }, [connected, disconnect, isAccepted]);

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  // Whether the press that may become a backdrop "click" actually started on the
  // backdrop — so a drag starting inside the card and released on the backdrop, or a
  // mere press, does not dismiss.
  const pressedBackdrop = useRef(false);

  // On mount (= when the gate opens): remember what had focus, move focus into the
  // dialog, lock body scroll, trap Tab inside the dialog, and close on Escape. Cleanup
  // (on unmount = close) restores scroll and returns focus to the opener, matching the
  // app's useMenu behavior (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    checkboxRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      // Trap focus: aria-modal="true" promises the background is inert, so Tab must
      // wrap within the dialog instead of escaping to the page behind the backdrop.
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4 backdrop-blur-sm"
      // Dismiss only on a full click that BOTH starts and ends on the backdrop itself
      // (not a press, not a drag out of the card) — it only aborts connecting.
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-gate-title"
        className="k-card animate-pop flex max-h-[90vh] w-full max-w-sm flex-col items-center gap-3 overflow-y-auto p-6 text-center"
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
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
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
