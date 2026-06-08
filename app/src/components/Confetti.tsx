"use client";

import { useMemo } from "react";

/**
 * A small one-shot celebratory burst (hearts / stars / confetti dots in pastel
 * colors) that emanates from its container. Mounts with a success moment and plays
 * once; decorative and non-interactive. Disabled (invisible) under
 * prefers-reduced-motion via the global animation opt-out.
 */
const COLORS = ["#ff8fbf", "#b79cf2", "#7fe0c0", "#8ccdf5", "#ffd97a", "#ff5e9a"];
const SHAPES = ["heart", "star", "dot"] as const;

export function Confetti({ count = 18 }: { count?: number }) {
  // Deterministic per-index fan (pure — no Math.random in render, which the React
  // Compiler forbids). Pieces spread across an upward arc with varied spin/size.
  const pieces = useMemo(
    () =>
      Array.from({ length: count }).map((_, i) => {
        const t = count > 1 ? i / (count - 1) : 0.5; // 0..1 across the fan
        const angle = -Math.PI / 2 + (t - 0.5) * 2.5; // upward arc, ±~72°
        const dist = 64 + ((i * 37) % 56); // 64..120px
        return {
          i,
          tx: Math.round(Math.cos(angle) * dist),
          ty: Math.round(Math.sin(angle) * dist), // negative = upward
          rot: ((i * 53) % 360) - 180,
          delay: (i * 29) % 170,
          size: 7 + ((i * 13) % 8),
          color: COLORS[i % COLORS.length],
          shape: SHAPES[i % SHAPES.length],
        };
      }),
    [count],
  );

  return (
    <span className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
      {pieces.map((p) => (
        <span
          key={p.i}
          className="confetti-piece absolute left-1/2 top-1/3"
          style={
            {
              width: p.size,
              height: p.size,
              color: p.color,
              animationDelay: `${p.delay}ms`,
              "--tx": `${p.tx}px`,
              "--ty": `${p.ty}px`,
              "--rot": `${p.rot}deg`,
            } as React.CSSProperties
          }
        >
          <Shape shape={p.shape} />
        </span>
      ))}
    </span>
  );
}

function Shape({ shape }: { shape: (typeof SHAPES)[number] }) {
  if (shape === "heart") {
    return (
      <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
        <path
          d="M12 21C5 16 3 12.5 3 9.2 3 6.7 5 5 7.2 5 9 5 10.7 6.1 12 8 13.3 6.1 15 5 16.8 5 19 5 21 6.7 21 9.2 21 12.5 19 16 12 21Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  if (shape === "star") {
    return (
      <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
        <path
          d="M12 1c1.2 6 3.8 8.6 9.8 9.8C15.8 12 13.2 14.6 12 20.6 10.8 14.6 8.2 12 2.2 10.8 8.2 9.6 10.8 7 12 1Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return <span className="block h-full w-full rounded-[3px]" style={{ background: "currentColor" }} />;
}
