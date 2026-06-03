"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Bottom tab bar for phones (the header nav links are hidden < sm). Fixed to the
 * bottom with a safe-area inset; the root layout adds matching bottom padding so
 * content/footer clear it, and the Toaster lifts above it on mobile.
 */
const LINKS = [
  { href: "/", label: "Swap", icon: SwapIcon },
  { href: "/pools", label: "Pools", icon: PoolsIcon },
  { href: "/orders", label: "Orders", icon: OrdersIcon },
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/90 backdrop-blur-xl sm:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-md items-stretch justify-around px-2 py-1.5">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[11px] font-bold transition-colors ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded-full transition-colors ${
                  active ? "bg-accent/12" : ""
                }`}
              >
                <Icon />
              </span>
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function SwapIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4.5 2.5v9m0 0L2 9m2.5 2.5L7 9M11.5 13.5v-9m0 0L9 7m2.5-2.5L14 7"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PoolsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M8 1.8c2.6 3 4.4 5.2 4.4 7.2a4.4 4.4 0 11-8.8 0c0-2 1.8-4.2 4.4-7.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OrdersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path
        d="M5.2 6.2h5.6M5.2 8.6h5.6M5.2 11h3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
