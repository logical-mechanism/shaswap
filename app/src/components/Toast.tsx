"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Pip, type PipMood } from "./Pip";

/**
 * Lightweight, dependency-free toast system for ephemeral, app-wide messages
 * (wallet connect/disconnect, wrong-network, and other one-off notices). Toasts
 * are branded — each carries a Pip reacting to the moment. Persistent, action-
 * bearing outcomes (a posted order, a tx hash) stay as the inline result banners
 * inside their flow; toasts are for fleeting "heads up" moments only.
 *
 * Usage:  const { toast } = useToast();  toast({ variant, title, message });
 */

export type ToastVariant = "info" | "success" | "warn" | "danger";

export interface ToastInput {
  variant?: ToastVariant;
  title: string;
  message?: string;
  /** Override the Pip expression (defaults per variant). */
  mood?: PipMood;
  /** Auto-dismiss after N ms. 0 = sticky (manual dismiss only). Default 5000. */
  duration?: number;
}

interface Toast extends ToastInput {
  id: string;
  variant: ToastVariant;
}

interface ToastApi {
  toast: (t: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** At most this many toasts stack at once; older ones drop off the top. */
const MAX_TOASTS = 4;

const DEFAULT_MOOD: Record<ToastVariant, PipMood> = {
  info: "happy",
  success: "love",
  warn: "worried",
  danger: "worried",
};

const ACCENT: Record<ToastVariant, string> = {
  info: "var(--accent-2)",
  success: "var(--success)",
  warn: "var(--warning)",
  danger: "var(--danger)",
};

const TITLE_CLASS: Record<ToastVariant, string> = {
  info: "text-ink",
  success: "text-success",
  warn: "text-warning",
  danger: "text-danger",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const variant = input.variant ?? "info";
      const duration = input.duration ?? 5000;
      setToasts((ts) => [...ts, { ...input, id, variant }].slice(-MAX_TOASTS));
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-[60] flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2 sm:bottom-4 sm:right-4"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { variant } = toast;
  return (
    <div
      role="status"
      className="pointer-events-auto w-full max-w-sm animate-toast-in rounded-2xl border border-border bg-surface p-3 shadow-[0_24px_50px_-22px_rgba(150,110,190,0.55)]"
      style={{ borderLeft: `5px solid ${ACCENT[variant]}` }}
    >
      <div className="flex items-start gap-2.5">
        <span className="shrink-0">
          <Pip size={36} mood={toast.mood ?? DEFAULT_MOOD[variant]} />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className={`text-sm font-bold ${TITLE_CLASS[variant]}`}>
            {toast.title}
          </div>
          {toast.message && (
            <div className="mt-0.5 break-words text-xs text-muted">
              {toast.message}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="-mr-0.5 -mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-sunk hover:text-ink"
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
      </div>
    </div>
  );
}
