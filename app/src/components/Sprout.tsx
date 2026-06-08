/**
 * A tiny garden motif for the "liquidity gardens" pool cards — a data-honest growth cue:
 * `growing` (a green sprout) for a pool that holds liquidity, `seed` (a resting seed) for a
 * pool still waiting for its first deposit. Pure SVG in Pip's soft, rounded vector language,
 * reusing the pastel palette (mint/peach/sun). Static by design: it sits next to live numbers,
 * so it never loops or bobs. Decorative (aria-hidden) — the card's text carries the meaning.
 */
export function Sprout({
  state = "growing",
  size = 20,
  className = "",
}: {
  state?: "growing" | "seed";
  size?: number;
  className?: string;
}) {
  if (state === "seed") {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={className}
        fill="none"
        aria-hidden
      >
        {/* soil */}
        <ellipse cx="12" cy="19" rx="7.5" ry="2.4" fill="#ffc49b" opacity="0.5" />
        {/* resting seed */}
        <path
          d="M12 8c2.7 0 4.6 2.1 4.6 4.8S14.7 17.4 12 17.4 7.4 15.5 7.4 12.8 9.3 8 12 8Z"
          fill="#ffd97a"
        />
        <path d="M12 9.4v6.4" stroke="#e0a93f" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      aria-hidden
    >
      {/* soil */}
      <ellipse cx="12" cy="20.5" rx="8" ry="2.2" fill="#7fe0c0" opacity="0.4" />
      {/* stem */}
      <path d="M12 20.5V10" stroke="#4fc59c" strokeWidth="2" strokeLinecap="round" />
      {/* left leaf */}
      <path d="M11.5 14c-4.4 0-6.6-2.2-6.6-5.6 3.4 0 6.6 1.2 6.6 5.6Z" fill="#7fe0c0" />
      {/* right leaf */}
      <path d="M12.5 12.5c0-4.4 2.2-6.6 6.6-6.6 0 3.4-2.2 6.6-6.6 6.6Z" fill="#9be7cf" />
    </svg>
  );
}
