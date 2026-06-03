import { NextResponse, type NextRequest } from "next/server";
import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/pool/mint-inputs?nft=<unit> — the input OutputReferences of the tx that
 * minted a pool (by its NFT unit). The pool's one-shot `pool_mint(seed)` seed is one
 * of these; the client recovers it by testing which input reproduces the pool's policy
 * id (pure `applyParamsToScript`/`resolveScriptHash`). Used by the close-pool builder
 * to burn NFT + LP under the seed-applied policy. Through the seam so the provider key
 * stays server-side.
 */
export async function GET(req: NextRequest) {
  const nft = req.nextUrl.searchParams.get("nft");
  if (!nft || !/^[0-9a-fA-F]{56,}$/.test(nft)) {
    return NextResponse.json(
      { error: "required query param: nft (pool NFT unit, policy+name hex)" },
      { status: 400 },
    );
  }
  return providerJson("pool/mint-inputs", async () => ({
    inputs: await getDataProvider().poolMintInputs(nft.toLowerCase()),
  }));
}
