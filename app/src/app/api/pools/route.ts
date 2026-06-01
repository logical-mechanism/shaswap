import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/**
 * GET /api/pools — list all known pools.
 *
 * The server is the data layer: the client fetches our own /api/* and never a
 * provider SDK. Provider selection (and any keys) live behind getDataProvider().
 */
export async function GET() {
  return providerJson("pools", async () => ({
    pools: await getDataProvider().listPools(),
  }));
}
