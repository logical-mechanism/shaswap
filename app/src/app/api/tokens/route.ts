import { NextResponse } from "next/server";
import { getDataProvider } from "@/lib/data";

/** GET /api/tokens — tokens available to the selectors. */
export async function GET() {
  const provider = getDataProvider();
  const tokens = await provider.listTokens();
  return NextResponse.json({ tokens });
}
