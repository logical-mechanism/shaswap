import { NextRequest, NextResponse } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/quote?in=<unit>&out=<unit>&amount=<baseUnits>
 *
 * Returns a price quote through the data abstraction. `amount` must be a
 * non-negative integer base-unit string; junk is rejected at this trust
 * boundary with a 400 (rather than relying on the provider to coerce it). In
 * the skeleton the MockProvider answers with a toy curve — NOT the protocol's
 * clearing math, and nothing is built or submitted.
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
  if (!/^\d+$/.test(amount)) {
    return NextResponse.json(
      { error: "amount must be a non-negative integer (base units)" },
      { status: 400 },
    );
  }

  return providerJson("quote", async () => {
    const quote = await getDataProvider().priceQuote(tokenIn, tokenOut, amount);
    return { quote: quote ?? null };
  });
}
