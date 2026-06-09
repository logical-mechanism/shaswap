import { NextRequest, NextResponse } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * POST /api/asset-meta  body: { units: string[] }
 *
 * Filters a set of wallet-held asset units down to the ones in the off-chain token
 * registry (CIP-26), returning their `TokenInfo`. NFTs / unregistered assets are dropped.
 * Used by Create-Pool so the token picker shows real fungible tokens, not a wallet's NFT
 * clutter. POST (not GET) because a wallet can hold many units — too long for a query string.
 */
export async function POST(req: NextRequest) {
  let body: { units?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.units)) {
    return NextResponse.json(
      { error: "units must be a string array" },
      { status: 400 },
    );
  }
  const units = body.units.filter((u): u is string => typeof u === "string");
  // Bound the request so an oversized body can't fan out unbounded provider reads (the
  // provider also caps its own scan).
  const capped = units.slice(0, 200);

  return providerJson("asset-meta", async () => ({
    tokens: await getDataProvider().listRegisteredTokens(capped),
  }));
}
