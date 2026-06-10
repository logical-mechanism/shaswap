"use client";

import { usePathname } from "next/navigation";
import {
  APP_CONFIG,
  NETWORK_SITE_URLS,
  networkLabel,
  type Network,
} from "@/lib/config";
import { useMenu } from "@/hooks/useMenu";
import { Pip } from "./Pip";

/**
 * Footer network switcher. ShaSwap runs one deployment per network on its own
 * domain (see `.do/`), so "switching network" is a cross-domain redirect to the
 * sister app — not an in-app toggle. The footer pill that used to merely *show*
 * the active network now opens a small upward menu of the other live networks;
 * picking one sends you there.
 *
 * Only networks in `NETWORK_SITE_URLS` (i.e. ones with a public deployment) are
 * offered, minus the active one — you're already on it, and `preview` has no
 * public app to hop to.
 */
export function NetworkSwitcher() {
  const { open, setOpen, containerRef, triggerRef } = useMenu();
  const pathname = usePathname();
  const active = APP_CONFIG.network;

  // Carry the current path across so a switch lands you on the same page on the
  // other network. Pool deep-links (`/pools/<id>`) carry a network-specific id
  // that won't exist elsewhere, so fall back to the pool list for those.
  const carryPath = pathname.startsWith("/pools/") ? "/pools" : pathname;

  const targets = (Object.keys(NETWORK_SITE_URLS) as Network[]).filter(
    (n) => n !== active,
  );

  function go(network: Network) {
    const base = NETWORK_SITE_URLS[network];
    if (!base) return;
    setOpen(false);
    window.location.assign(`${base}${carryPath}`);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch network"
        className="k-pill text-xs"
      >
        <Pip size={18} mood="happy" />
        {networkLabel()}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className={`text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
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
        <span className="sr-only">network {active} — switch network</span>
      </button>

      {open && (
        <div className="k-pop animate-pop absolute bottom-full right-0 z-40 mb-2 w-52 p-2">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Switch network
          </div>
          {targets.length === 0 ? (
            <p className="px-2 py-2 text-xs leading-relaxed text-muted">
              No other network to hop to right now.
            </p>
          ) : (
            <div className="mt-1 space-y-1">
              {targets.map((n) => {
                const host = new URL(NETWORK_SITE_URLS[n]!).host;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => go(n)}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-sunk"
                  >
                    <Pip size={20} mood="happy" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">
                        {networkLabel(n)}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted">
                        {host}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
