import { NextResponse } from "next/server";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/pools — list all known pools.
 *
 * The server is the data layer: the client fetches our own /api/* and never a
 * provider SDK. Provider selection (and any keys) live behind getDataProvider().
 */
export async function GET() {
  const provider = getDataProvider();
  const pools = await provider.listPools();
  return NextResponse.json({ pools });
}
