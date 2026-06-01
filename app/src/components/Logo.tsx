import Link from "next/link";

/** ShaSwap wordmark + mark. Links home. */
export function Logo() {
  return (
    <Link
      href="/"
      className="group flex items-center gap-2.5"
      aria-label="ShaSwap home"
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-sm font-black text-black shadow-glow transition-transform group-hover:scale-105"
        aria-hidden
      >
        ∿
      </span>
      <span className="text-lg font-semibold tracking-tight">
        Sha<span className="text-accent">Swap</span>
      </span>
    </Link>
  );
}
