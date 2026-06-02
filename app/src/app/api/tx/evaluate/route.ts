import { NextResponse, type NextRequest } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * POST /api/tx/evaluate  { tx: "<cbor hex>" } — script execution units for a draft tx.
 *
 * Used by the client-side reclaim builder: the browser builds an unbalanced draft,
 * asks us to evaluate it (Plutus ex-units for the `Reclaim` spend), then rebuilds with
 * the returned budgets. Keeps the provider (and key) server-side.
 */
export async function POST(req: NextRequest) {
  let tx: unknown;
  try {
    tx = (await req.json())?.tx;
  } catch {
    tx = undefined;
  }
  if (typeof tx !== "string" || tx.length === 0) {
    return NextResponse.json(
      { error: "missing required body field: tx (cbor hex)" },
      { status: 400 },
    );
  }
  return providerJson("tx/evaluate", async () => ({
    actions: await getDataProvider().evaluateTx(tx),
  }));
}
