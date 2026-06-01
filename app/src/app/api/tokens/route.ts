import { providerJson } from "@/lib/api";
import { getDataProvider } from "@/lib/data";

/** GET /api/tokens — tokens available to the selectors. */
export async function GET() {
  return providerJson("tokens", async () => ({
    tokens: await getDataProvider().listTokens(),
  }));
}
