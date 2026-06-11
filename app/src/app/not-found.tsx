import Link from "next/link";
import { Pip } from "@/components/Pip";

/** Branded 404 — replaces Next.js's stock not-found screen. */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="k-card flex flex-col items-center px-6 py-12">
        <Pip size={72} mood="thinking" />
        <h1 className="mt-4 font-display text-2xl font-extrabold text-ink">
          Pip looked everywhere…
        </h1>
        <p className="mt-2 max-w-xs text-sm text-muted">
          …but this page isn’t here. It may have moved, or the link’s off.
        </p>
        <Link href="/" className="k-btn mt-5 px-5 py-2.5 text-sm">
          Back to Swap
        </Link>
      </div>
    </div>
  );
}
