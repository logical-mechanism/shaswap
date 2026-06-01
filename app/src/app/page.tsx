import { SwapCard } from "@/components/swap/SwapCard";

export default function SwapPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:py-16">
      <SwapCard />
      <p className="mt-6 max-w-md text-center text-xs text-muted">
        Skeleton preview — quotes are mock data through the data-access layer.
        No orders are built or submitted yet.
      </p>
    </div>
  );
}
