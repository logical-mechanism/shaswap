import { SwapCard } from "@/components/swap/SwapCard";
import { Pip } from "@/components/Pip";
import { Sparkles } from "@/components/decor";
import { Disclosure } from "@/components/Disclosure";

export default function SwapPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:py-16">
      <div className="mb-7 flex flex-col items-center text-center">
        <Pip size={96} mood="wave" float sparkles label="Pip, the ShaSwap mascot" />
        <h1 className="mt-4 font-display text-3xl font-extrabold text-ink sm:text-4xl">
          Swap with{" "}
          <span className="relative inline-block text-accent">
            Pip
            <Sparkles className="absolute -right-3 -top-1" />
          </span>
        </h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Drop off an order; everyone settles at one fair price — nobody jumps
          the queue.
        </p>
      </div>

      <SwapCard />

      <Disclosure summary="How does this work?" className="mt-6 w-full max-w-md">
        <div className="k-note k-note-info flex gap-3 text-xs leading-relaxed">
          <span className="shrink-0">
            <Pip size={34} mood="thinking" />
          </span>
          <div className="space-y-2">
            <p>
              You don’t swap on the spot — you drop off an order. Every little
              while, all orders for a pair settle together at one shared price,
              so no one can sneak in front of you to move it.
            </p>
            <p>
              You always get at least the floor you set. Changed your mind? Grab your
              order back anytime. Your tokens never leave your control.
            </p>
            <p>
              One honest note: your order rests on a public chain until it settles
              or you grab it back. Its price is visible, and it can fill whenever
              the market reaches your floor. A tight floor and a shorter expiry keep
              it snug.
            </p>
            <p className="text-muted">
              Quotes come from live pool reserves — estimates until the batch
              settles.
            </p>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
