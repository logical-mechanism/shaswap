import { NextRequest, NextResponse } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/lp-intents?address=<bech32> — a wallet's open batcher-fulfilled LP intents
 * (deposit/withdraw UTXOs at the `lp_intent` address it owns). Mirrors /api/orders; through
 * the data seam so the provider key stays server-side. Empty on a network where the
 * LP-intent path isn't live (preview).
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json(
      { error: "missing required param: address" },
      { status: 400 },
    );
  }

  return providerJson("lp-intents", async () => ({
    intents: await getDataProvider().walletLpIntents(address),
  }));
}
