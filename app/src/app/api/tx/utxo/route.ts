import { NextResponse, type NextRequest } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/tx/utxo?tx=<hash>&index=<n> — resolve a single UTXO (value + inline datum).
 *
 * Used by the client reclaim builder to fetch the on-chain order UTXO it spends.
 * Through the seam so the provider key stays server-side.
 */
export async function GET(req: NextRequest) {
  const tx = req.nextUrl.searchParams.get("tx");
  const indexParam = req.nextUrl.searchParams.get("index");
  const index = Number(indexParam);
  if (!tx || indexParam === null || !Number.isInteger(index) || index < 0) {
    return NextResponse.json(
      { error: "required query params: tx (hash), index (non-negative int)" },
      { status: 400 },
    );
  }
  return providerJson("tx/utxo", async () => ({
    utxo: await getDataProvider().resolveUtxo(tx, index),
  }));
}
