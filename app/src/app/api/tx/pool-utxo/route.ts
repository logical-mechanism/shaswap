import { NextResponse, type NextRequest } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/tx/pool-utxo?nft=<unit> — resolve the live pool UTXO (value + inline
 * `PoolDatum`) for a pool identified by its NFT unit (`policy+name`).
 *
 * Used by the client LP deposit/withdraw builders to fetch the pool UTXO they spend
 * on the `LpAction` path. Through the seam so the provider key stays server-side.
 */
export async function GET(req: NextRequest) {
  const nft = req.nextUrl.searchParams.get("nft");
  if (!nft || !/^[0-9a-fA-F]{56,}$/.test(nft)) {
    return NextResponse.json(
      { error: "required query param: nft (pool NFT unit, policy+name hex)" },
      { status: 400 },
    );
  }
  return providerJson("tx/pool-utxo", async () => ({
    utxo: await getDataProvider().resolvePoolUtxo(nft.toLowerCase()),
  }));
}
