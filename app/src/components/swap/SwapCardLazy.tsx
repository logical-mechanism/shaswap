"use client";

import dynamic from "next/dynamic";

/**
 * Client-only lazy wrapper around `SwapCard`.
 *
 * `SwapCard` reads wallet state via `@meshsdk/react` hooks, which pulls the heavy
 * `@meshsdk/core-cst` WASM into its chunk. Loading it after first paint keeps that weight
 * off the home route's initial bundle so the shell (Pip + heading) paints immediately.
 *
 * The `ssr: false` dynamic lives here, in a client component, because the home page
 * (`app/page.tsx`) is a Server Component and `next/dynamic({ ssr: false })` is not allowed
 * there. A card-shaped skeleton holds the slot to keep layout shift minimal while the
 * chunk streams in.
 */
const SwapCard = dynamic(() => import("./SwapCard").then((m) => m.SwapCard), {
  ssr: false,
  loading: () => <SwapCardSkeleton />,
});

export function SwapCardLazy() {
  return <SwapCard />;
}

/** Placeholder roughly matching SwapCard's footprint (header · from · flip · to · rate · CTA). */
function SwapCardSkeleton() {
  return (
    <div className="k-card w-full max-w-md p-5 sm:p-6" aria-hidden>
      <div className="mb-4 h-7 w-28 animate-pulse rounded-full bg-surface-sunk" />
      <div className="h-[5.5rem] animate-pulse rounded-2xl bg-surface-sunk" />
      <div className="-my-3 flex justify-center">
        <div className="h-11 w-11 animate-pulse rounded-full bg-surface-sunk" />
      </div>
      <div className="h-[5.5rem] animate-pulse rounded-2xl bg-surface-sunk" />
      <div className="mt-3 h-11 animate-pulse rounded-2xl bg-surface-sunk" />
      <div className="mt-4 h-[3.25rem] animate-pulse rounded-full bg-surface-sunk" />
    </div>
  );
}
