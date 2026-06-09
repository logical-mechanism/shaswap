import { NextRequest, NextResponse } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/reference-price?a=<unit>&b=<unit>
 *
 * A non-binding external market reference (human tokenB per 1 tokenA), or null when
 * unavailable. Used to suggest a sane opening price on a pool's first deposit. App-only
 * convenience sourced server-side through the data seam — the protocol never reads it.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const a = searchParams.get("a");
  const b = searchParams.get("b");

  if (!a || !b) {
    return NextResponse.json(
      { error: "missing required params: a, b" },
      { status: 400 },
    );
  }

  return providerJson("reference-price", async () => ({
    reference: await getDataProvider().referencePrice(a, b),
  }));
}
