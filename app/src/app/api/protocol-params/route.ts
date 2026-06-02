import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/protocol-params — current protocol parameters + Plutus cost models.
 *
 * Served through the data seam so the client-side `MeshTxBuilder` can compute fees AND
 * the script-integrity hash without a provider SDK (or its key) in the browser. The
 * browser passes `params` to the builder and `costModels` (`[v1, v2, v3]`) to
 * `txBuilder.setCostModels(...)` so the hash matches the node (MeshJS's baked-in
 * defaults are stale relative to preprod's protocol version).
 */
export async function GET() {
  return providerJson("protocol-params", async () => {
    const dp = getDataProvider();
    const [params, costModels] = await Promise.all([
      dp.protocolParameters(),
      dp.costModels(),
    ]);
    return { params, costModels };
  });
}
