"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

// WalletBar reads wallet state via `@meshsdk/react`, which transitively pulls the heavy
// `@meshsdk/core-cst` WASM. Load it as its own client-only chunk after first paint so the
// header chrome renders instantly; a pill-shaped skeleton holds the slot to avoid layout
// shift until it streams in.
const WalletBar = dynamic(() => import("./WalletBar").then((m) => m.WalletBar), {
  ssr: false,
  loading: () => (
    <div
      aria-hidden
      className="h-9 w-36 animate-pulse rounded-full bg-surface-sunk"
    />
  ),
});

const LINKS = [
  { href: "/", label: "Swap" },
  { href: "/pools", label: "Pools" },
  { href: "/orders", label: "Orders" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Logo />
          <nav className="hidden items-center gap-1 sm:flex">
            {LINKS.map((link) => {
              const active =
                link.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${
                    active
                      ? "bg-accent/12 text-accent font-bold"
                      : "text-muted hover:text-accent"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          <WalletBar />
        </div>
      </div>
    </header>
  );
}
