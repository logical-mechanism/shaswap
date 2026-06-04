import { NextResponse, type NextRequest } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/tx/status?tx=<hash> — whether a tx is CONFIRMED on-chain (in a block).
 *
 * The Orders view uses this to reconcile an optimistic reclaim: a reclaim and a solver
 * settlement both spend the order UTXO, so only the reclaim tx being on-chain proves the
 * reclaim actually landed (rather than losing a mempool race to a settlement — a
 * double-spend that never confirms). Through the seam so the provider key stays
 * server-side.
 */
export async function GET(req: NextRequest) {
  const tx = req.nextUrl.searchParams.get("tx");
  if (!tx) {
    return NextResponse.json(
      { error: "required query param: tx (hash)" },
      { status: 400 },
    );
  }
  return providerJson("tx/status", async () => ({
    confirmed: await getDataProvider().transactionConfirmed(tx),
  }));
}
