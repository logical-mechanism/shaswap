import { NextRequest, NextResponse } from "next/server";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/quote?in=<unit>&out=<unit>&amount=<baseUnits>
 *
 * Returns a price quote through the data abstraction. In the skeleton the
 * MockProvider answers with a toy curve — NOT the protocol's clearing math, and
 * nothing is built or submitted.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const tokenIn = searchParams.get("in");
  const tokenOut = searchParams.get("out");
  const amount = searchParams.get("amount");

  if (!tokenIn || !tokenOut || !amount) {
    return NextResponse.json(
      { error: "missing required params: in, out, amount" },
      { status: 400 },
    );
  }

  const provider = getDataProvider();
  const quote = await provider.priceQuote(tokenIn, tokenOut, amount);
  if (!quote) {
    return NextResponse.json({ quote: null });
  }
  return NextResponse.json({ quote });
}
