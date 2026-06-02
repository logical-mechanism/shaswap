import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/protocol-params — current protocol parameters.
 *
 * Served through the data seam so the client-side `MeshTxBuilder` can compute fees
 * without a provider SDK (or its key) in the browser. The browser fetches this, then
 * passes `params` to `txBuilder.protocolParams(params)`.
 */
export async function GET() {
  return providerJson("protocol-params", async () => ({
    params: await getDataProvider().protocolParameters(),
  }));
}
