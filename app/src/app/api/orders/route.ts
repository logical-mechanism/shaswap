import { NextRequest, NextResponse } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/orders?address=<bech32> — a wallet's open orders / positions.
 *
 * Read-only in the skeleton (the MockProvider returns an illustrative set).
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json(
      { error: "missing required param: address" },
      { status: 400 },
    );
  }

  return providerJson("orders", async () => ({
    orders: await getDataProvider().walletPositions(address),
  }));
}
