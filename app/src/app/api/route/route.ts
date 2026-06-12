import { NextRequest, NextResponse } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/route?in=<unit>&out=<unit>&amount=<baseUnits>&tip=<lovelace>
 *
 * Returns the best SPLIT route for a swap through the data abstraction — how to spread
 * `amount` across the sharded pools for the pair to maximize output (BLUEPRINT §5.5),
 * gated by the per-leg solver `tip` (each leg is its own pool-bound order). A one-leg route
 * is the single-best-pool case. `amount` and `tip` must be non-negative integer base-unit
 * strings; junk is rejected at this trust boundary with a 400.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const tokenIn = searchParams.get("in");
  const tokenOut = searchParams.get("out");
  const amount = searchParams.get("amount");
  const tip = searchParams.get("tip");

  if (!tokenIn || !tokenOut || !amount || tip === null) {
    return NextResponse.json(
      { error: "missing required params: in, out, amount, tip" },
      { status: 400 },
    );
  }
  if (!/^\d+$/.test(amount) || !/^\d+$/.test(tip)) {
    return NextResponse.json(
      { error: "amount and tip must be non-negative integers (base units / lovelace)" },
      { status: 400 },
    );
  }

  return providerJson("route", async () => {
    const route = await getDataProvider().routeQuote(tokenIn, tokenOut, amount, tip);
    return { route: route ?? null };
  });
}
