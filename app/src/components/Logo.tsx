import Link from "next/link";
import { Pip } from "./Pip";

/** ShaSwap wordmark + Pip mark. Links home. */
export function Logo() {
  return (
    <Link
      href="/"
      className="group flex items-center gap-2.5"
      aria-label="ShaSwap home"
    >
      <span
        className="grid h-10 w-10 place-items-center rounded-2xl border border-border bg-surface shadow-[0_8px_18px_-10px_rgba(232,69,143,0.5)] transition-transform group-hover:-translate-y-0.5 group-hover:rotate-3"
        aria-hidden
      >
        <Pip size={30} mood="happy" />
      </span>
      <span className="font-display text-xl font-extrabold tracking-tight text-ink">
        Sha<span className="text-accent">Swap</span>
      </span>
    </Link>
  );
}
