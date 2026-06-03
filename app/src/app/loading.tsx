import { PipLoading } from "@/components/PipLoading";

/** Route-transition fallback — a branded Pip loader instead of a blank frame. */
export default function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center py-20">
      <PipLoading label="Pip’s getting things ready…" />
    </div>
  );
}
