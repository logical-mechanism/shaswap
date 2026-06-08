/**
 * Pip — ShaSwap's mascot: a small, chubby, lavender forest creature who runs the
 * woodland market — tending the liquidity gardens (pools) and gathering everyone's
 * orders into baskets that settle together at one fair price. One vector component,
 * rendered consistently everywhere
 * (hero, empty states, loading, success, toasts, badges, the logo mark). Expression
 * is driven by `mood`; `sparkles` adds twinkles; `size` scales the whole thing.
 *
 * Moods are deliberately varied so Pip can react in-context: cheerful on success,
 * worried on (soft, recoverable) warnings, calm + reassuring on errors / signing,
 * heart-eyes on a happy outcome, cheer (both arms up) on a genuine win, cool when
 * connected, thinking while loading. Pure SVG (no raster assets) so Pip is crisp at
 * any size and themeable.
 *
 * The `still` prop freezes ALL of Pip's motion — the float bob, the wave wiggle, and
 * the love/thinking overlay twinkles — so Pip can stand calmly through the
 * security-critical moments (signing, warnings, errors) where the brand keeps motion
 * out. It's the brand's "calm during signing" guarantee, independent of the user's OS
 * prefers-reduced-motion setting.
 */

export type PipMood =
  | "happy"
  | "wink"
  | "sparkle"
  | "sleepy"
  | "wave"
  | "worried"
  | "calm"
  | "love"
  | "cheer"
  | "cool"
  | "thinking";

export function Pip({
  mood = "happy",
  size = 96,
  sparkles = false,
  float = false,
  still = false,
  label,
  className = "",
}: {
  mood?: PipMood;
  size?: number;
  /** Render a few twinkles around Pip. */
  sparkles?: boolean;
  /** Gently bob up and down (disabled under prefers-reduced-motion). */
  float?: boolean;
  /**
   * Freeze every bit of Pip's motion — bob, wave wiggle, and the love/thinking
   * overlay twinkles — and suppress decorative sparkles. Use on signing, warning, and
   * error surfaces so Pip stays calm regardless of prefers-reduced-motion.
   */
  still?: boolean;
  /** Accessible name. Omit to mark Pip decorative (aria-hidden). */
  label?: string;
  className?: string;
}) {
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);

  return (
    <span
      className={`relative inline-block leading-none ${float && !still ? "animate-bob" : ""} ${className}`}
      style={{ width: size, height: size }}
      {...a11y}
    >
      <svg
        viewBox="0 0 120 120"
        width={size}
        height={size}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="pip-fur" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#cdb9f7" />
            <stop offset="1" stopColor="#b193ee" />
          </linearGradient>
          <linearGradient id="pip-fur-deep" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#b89bf1" />
            <stop offset="1" stopColor="#a585e9" />
          </linearGradient>
          <radialGradient id="pip-front" cx="0.5" cy="0.38" r="0.75">
            <stop offset="0" stopColor="#fffaff" />
            <stop offset="1" stopColor="#fdeef8" />
          </radialGradient>
          <radialGradient id="pip-gloss" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* feet */}
        <ellipse cx="45" cy="107" rx="14" ry="8" fill="url(#pip-fur-deep)" />
        <ellipse cx="75" cy="107" rx="14" ry="8" fill="url(#pip-fur-deep)" />
        <circle cx="40" cy="110" r="1.7" fill="#fdeef8" />
        <circle cx="46" cy="111" r="1.7" fill="#fdeef8" />
        <circle cx="74" cy="111" r="1.7" fill="#fdeef8" />
        <circle cx="80" cy="110" r="1.7" fill="#fdeef8" />

        {/* ears */}
        <ellipse cx="25" cy="45" rx="7" ry="9" fill="url(#pip-fur-deep)" />
        <ellipse cx="95" cy="45" rx="7" ry="9" fill="url(#pip-fur-deep)" />
        <ellipse cx="25" cy="45" rx="3" ry="4.5" fill="#fdeef8" opacity="0.8" />
        <ellipse cx="95" cy="45" rx="3" ry="4.5" fill="#fdeef8" opacity="0.8" />

        {/* arms — cheer raises both; wave raises+wiggles the right; else both tucked */}
        {mood === "cheer" ? (
          <>
            <ellipse cx="19" cy="44" rx="7.5" ry="11" fill="url(#pip-fur)" />
            <ellipse cx="101" cy="44" rx="7.5" ry="11" fill="url(#pip-fur)" />
          </>
        ) : (
          <>
            <ellipse cx="20" cy="80" rx="8" ry="11" fill="url(#pip-fur)" />
            {mood === "wave" ? (
              <g
                className={still ? "" : "animate-wiggle"}
                style={{ transformOrigin: "96px 64px" }}
              >
                <ellipse cx="101" cy="44" rx="7.5" ry="11" fill="url(#pip-fur)" />
              </g>
            ) : (
              <ellipse cx="100" cy="80" rx="8" ry="11" fill="url(#pip-fur)" />
            )}
          </>
        )}

        {/* cowlick */}
        <path
          d="M60 17c-2-7 3-11 5-9 0 3-1 5-2 7M60 17c2-6 8-7 9-4-2 2-4 3-6 4"
          stroke="#a585e9"
          strokeWidth="3"
          strokeLinecap="round"
          fill="none"
        />

        {/* body */}
        <path
          d="M60 15c26 0 42 19 42 45 0 27-17 47-42 47S18 87 18 60c0-26 16-45 42-45Z"
          fill="url(#pip-fur)"
        />

        {/* cream front */}
        <ellipse cx="60" cy="77" rx="25" ry="25" fill="url(#pip-front)" />

        {/* gloss highlight */}
        <ellipse cx="44" cy="40" rx="14" ry="9" fill="url(#pip-gloss)" />

        {/* blush */}
        <ellipse cx="39" cy="64" rx="6.5" ry="4.2" fill="#ff8fbf" opacity="0.55" />
        <ellipse cx="81" cy="64" rx="6.5" ry="4.2" fill="#ff8fbf" opacity="0.55" />

        {/* eyes / glasses */}
        <Eyes mood={mood} />

        {/* nose */}
        <path
          d="M60 58c2 0 3 1.4 3 2.8 0 1.6-1.6 2.6-3 3.6-1.4-1-3-2-3-3.6 0-1.4 1-2.8 3-2.8Z"
          fill="#b06a93"
        />

        {/* mouth */}
        <Mouth mood={mood} />

        {/* mood overlays */}
        {mood === "worried" && <WorriedExtras />}
        {mood === "love" && <FloatingHearts still={still} />}
        {mood === "thinking" && <ThoughtDots still={still} />}
      </svg>

      {sparkles && !still && (
        <>
          <Twinkle className="absolute -right-1 -top-1" size={size * 0.26} delay="0s" />
          <Twinkle className="absolute -left-2 top-1/3" size={size * 0.17} delay="0.7s" />
          <Twinkle className="absolute -bottom-1 right-1/4" size={size * 0.2} delay="1.2s" />
        </>
      )}
    </span>
  );
}

function Eyes({ mood }: { mood: PipMood }) {
  if (mood === "cool") {
    return <Sunglasses />;
  }
  if (mood === "love") {
    return (
      <>
        <HeartEye cx={47} cy={52} />
        <HeartEye cx={73} cy={52} />
      </>
    );
  }
  if (mood === "sleepy") {
    return (
      <g stroke="#3c2b54" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M42 53c2 3 6 3 9 0" />
        <path d="M69 53c2 3 6 3 9 0" />
      </g>
    );
  }
  if (mood === "sparkle") {
    return (
      <>
        <StarEye cx={47} cy={52} />
        <StarEye cx={73} cy={52} />
      </>
    );
  }
  // round-eye family: happy, wave, worried, calm, cheer, thinking, wink
  // thinking looks up (highlight high); others look ahead.
  const lookUp = mood === "thinking";
  const wink = mood === "wink";
  return (
    <>
      <RoundEye cx={47} lookUp={lookUp} />
      {wink ? (
        <path
          d="M68 53c2 3 6 3 9 0"
          stroke="#3c2b54"
          strokeWidth="2.8"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <RoundEye cx={73} lookUp={lookUp} />
      )}
    </>
  );
}

function RoundEye({ cx, lookUp = false }: { cx: number; lookUp?: boolean }) {
  const hy = lookUp ? 47.5 : 49.3;
  return (
    <>
      <ellipse cx={cx} cy="52" rx="6.2" ry="8" fill="#3c2b54" />
      <circle cx={cx + 2.3} cy={hy} r="2.1" fill="#fff" />
      <circle cx={cx - 1.6} cy="54.6" r="1" fill="#fff" opacity="0.8" />
    </>
  );
}

function StarEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <path
      d={`M${cx} ${cy - 8}c1.4 4 2.6 5.2 6.6 6.6-4 1.4-5.2 2.6-6.6 6.6-1.4-4-2.6-5.2-6.6-6.6 4-1.4 5.2-2.6 6.6-6.6Z`}
      fill="#3c2b54"
    />
  );
}

function HeartEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <path
      d={`M${cx} ${cy + 5.5}c-6-4-8-7-8-10 0-2.4 1.9-4 4-4 1.7 0 3.2 1.1 4 2.7 0.8-1.6 2.3-2.7 4-2.7 2.1 0 4 1.6 4 4 0 3-2 6-8 10Z`}
      fill="#ff5e9a"
    />
  );
}

function Sunglasses() {
  return (
    <g>
      {/* bridge + temples */}
      <path
        d="M52 49h16M40 49l-7-3M80 49l7-3"
        stroke="#2c2038"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
      {/* lenses */}
      <rect x="37" y="44" width="17" height="12" rx="5" fill="#2c2038" />
      <rect x="66" y="44" width="17" height="12" rx="5" fill="#2c2038" />
      {/* glints */}
      <path d="M40 53l5-6" stroke="#8ccdf5" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M69 53l5-6" stroke="#8ccdf5" strokeWidth="1.6" strokeLinecap="round" />
    </g>
  );
}

function WorriedExtras() {
  return (
    <g>
      {/* raised-inner (worried) brows */}
      <path
        d="M41 45l11-3M79 45l-11-3"
        stroke="#7a4f8c"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* sweat drop */}
      <path
        d="M90 33c2.4 3 3.6 5 3.6 6.6a3.6 3.6 0 11-7.2 0c0-1.6 1.2-3.6 3.6-6.6Z"
        fill="#8ccdf5"
      />
    </g>
  );
}

function FloatingHearts({ still = false }: { still?: boolean }) {
  const tw = still ? "" : "animate-twinkle";
  return (
    <g>
      <path
        className={tw}
        d="M36 14c-3-2-4-3.5-4-5 0-1.2 1-2 2-2 0.9 0 1.6 0.6 2 1.4 0.4-0.8 1.1-1.4 2-1.4 1 0 2 0.8 2 2 0 1.5-1 3-4 5Z"
        fill="#ff8fbf"
      />
      <path
        className={tw}
        style={{ animationDelay: "0.8s" }}
        d="M84 18c-3-2-4-3.5-4-5 0-1.2 1-2 2-2 0.9 0 1.6 0.6 2 1.4 0.4-0.8 1.1-1.4 2-1.4 1 0 2 0.8 2 2 0 1.5-1 3-4 5Z"
        fill="#ff5e9a"
      />
    </g>
  );
}

function ThoughtDots({ still = false }: { still?: boolean }) {
  const tw = still ? "" : "animate-twinkle";
  return (
    <g fill="#b79cf2">
      <circle className={tw} cx="75" cy="22" r="1.6" />
      <circle className={tw} style={{ animationDelay: "0.4s" }} cx="82" cy="16" r="2.2" />
      <circle className={tw} style={{ animationDelay: "0.8s" }} cx="90" cy="9" r="2.8" />
    </g>
  );
}

function Mouth({ mood }: { mood: PipMood }) {
  if (mood === "sparkle" || mood === "love" || mood === "cheer") {
    // open, delighted smile
    return <path d="M53 67c2 6 12 6 14 0 0 0-3 3-7 3s-7-3-7-3Z" fill="#b06a93" />;
  }
  if (mood === "calm") {
    // gentle, shallow, reassuring closed smile — softer than the default grin
    return (
      <path
        d="M55 67c3 3 7 3 10 0"
        stroke="#b06a93"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    );
  }
  if (mood === "worried") {
    // small wavy, uncertain mouth
    return (
      <path
        d="M54 68q3-3 6 0t6 0"
        stroke="#b06a93"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    );
  }
  if (mood === "cool") {
    // a little smirk
    return (
      <path
        d="M55 67c4 4 9 3 11-1"
        stroke="#b06a93"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    );
  }
  if (mood === "thinking") {
    // small, off-centre pondering mouth
    return (
      <path
        d="M56 68c2 2 5 2 7 0"
        stroke="#b06a93"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    );
  }
  return (
    <path
      d="M53 66c3 5 11 5 14 0"
      stroke="#b06a93"
      strokeWidth="2.6"
      strokeLinecap="round"
      fill="none"
    />
  );
}

/** A four-point sparkle/twinkle, positioned by the caller. */
export function Twinkle({
  size = 16,
  className = "",
  delay = "0s",
  color = "#ffd97a",
}: {
  size?: number;
  className?: string;
  delay?: string;
  color?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`animate-twinkle ${className}`}
      style={{ animationDelay: delay }}
      aria-hidden
    >
      <path
        d="M12 1c1.2 6 3.8 8.6 9.8 9.8C15.8 12 13.2 14.6 12 20.6 10.8 14.6 8.2 12 2.2 10.8 8.2 9.6 10.8 7 12 1Z"
        fill={color}
      />
    </svg>
  );
}
