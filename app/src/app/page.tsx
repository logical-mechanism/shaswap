import { SwapCard } from "@/components/swap/SwapCard";
import { Pip } from "@/components/Pip";
import { Disclosure } from "@/components/Disclosure";
import { networkLabel } from "@/lib/config";

export default function SwapPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:py-16">
      <div className="mb-7 flex flex-col items-center text-center">
        <Pip size={96} mood="wave" float sparkles label="Pip, the ShaSwap mascot" />
        <h1 className="mt-4 font-display text-3xl font-extrabold text-ink sm:text-4xl">
          Swap with <span className="text-accent">Pip</span>
        </h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Cozy, fair batch auctions on Cardano. Drop off an order — everyone in
          the batch gets the same fair price.
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
              You don’t swap on the spot — you drop off an order, and Pip does the
              rest. Every little while, all the orders for a pair settle
              together at one shared, fair price, so nobody can jump the line ahead of you.
            </p>
            <p>
              You always get at least the floor you set. Changed your mind? Grab your
              order back anytime — your tokens never leave your control.
            </p>
            <p className="text-muted">
              Prices come from live {networkLabel()} pool reserves, so a quote is just a
              friendly estimate until the batch settles.
            </p>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
