import { SwapCard } from "@/components/swap/SwapCard";

export default function SwapPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:py-16">
      <SwapCard />
      <p className="mt-6 max-w-md text-center text-xs text-muted">
        Quotes use live preprod reserves through the data-access layer. The
        quote is an estimate — you post an order (an intent) and an untrusted
        solver settles the batch later, never below your floor.
      </p>
    </div>
  );
}
