/**
 * Ambient kawaii decoration: soft floating pastel shapes and sparkle clusters.
 * Purely cosmetic and non-interactive (pointer-events-none, aria-hidden) so it
 * never gets in the way of the actual swap UI. Motion is gentle and pauses under
 * prefers-reduced-motion (handled globally in globals.css).
 */

import { Twinkle } from "./Pip";

/** A single blurred pastel blob. */
function Blob({
  className = "",
  color,
  size,
  delay = "0s",
}: {
  className?: string;
  color: string;
  size: number;
  delay?: string;
}) {
  return (
    <span
      className={`absolute rounded-full blur-2xl animate-float ${className}`}
      style={{
        width: size,
        height: size,
        background: color,
        animationDelay: delay,
      }}
    />
  );
}

/**
 * Full-screen ambient backdrop — mounted once behind the whole app. Sits below
 * content (-z-10) and never scrolls into the way.
 */
export function BackdropDecor() {
  return (
    <div
      className="backdrop-decor pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden
    >
      <Blob className="left-[-6rem] top-[-4rem]" color="rgba(183,156,242,0.45)" size={320} />
      <Blob
        className="right-[-5rem] top-[6rem]"
        color="rgba(255,143,191,0.4)"
        size={260}
        delay="1.5s"
      />
      <Blob
        className="bottom-[-6rem] left-[10%]"
        color="rgba(127,224,192,0.38)"
        size={300}
        delay="0.8s"
      />
      <Blob
        className="bottom-[2rem] right-[-4rem]"
        color="rgba(140,205,245,0.4)"
        size={240}
        delay="2.2s"
      />
      <Twinkle className="left-[12%] top-[18%]" size={22} delay="0s" color="#ffd97a" />
      <Twinkle className="right-[16%] top-[30%]" size={16} delay="0.6s" color="#ff8fbf" />
      <Twinkle className="left-[22%] bottom-[20%]" size={18} delay="1.1s" color="#b79cf2" />
      <Twinkle className="right-[24%] bottom-[28%]" size={14} delay="1.8s" color="#8ccdf5" />
    </div>
  );
}

/** A small reusable sparkle cluster for headers, success states, etc. */
export function Sparkles({ className = "" }: { className?: string }) {
  return (
    <span className={`pointer-events-none relative inline-block ${className}`} aria-hidden>
      <Twinkle className="absolute -left-1 -top-1" size={12} color="#ffd97a" />
      <Twinkle className="absolute right-0 top-1" size={9} delay="0.6s" color="#ff8fbf" />
      <Twinkle className="absolute -bottom-1 left-1/2" size={8} delay="1.1s" color="#b79cf2" />
    </span>
  );
}
