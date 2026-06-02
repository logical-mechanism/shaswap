import type { DataProvider } from "./provider";
import { MockProvider } from "./mock";
import { BlockfrostDataProvider } from "./blockfrost";

export type { DataProvider } from "./provider";
export type * from "./types";

/**
 * THE single swap point for the data-access abstraction (CLAUDE.md HARD RULE).
 *
 * To change the backing source (Blockfrost / Koios / Maestro / Kupo+Ogmios / our own
 * Dolos node later), implement `DataProvider` in a new file under this folder and
 * return it here — keyed off `DATA_PROVIDER`. That is the ONLY edit required; every
 * route handler and hook goes through this function, so no caller changes.
 *
 * This runs server-side ONLY (called from `/api/*` route handlers), so the provider
 * key (`BLOCKFROST_PROJECT_ID`) read here never reaches the client — safe to set as a
 * plain server env var (e.g. on the DigitalOcean app). The browser only fetches
 * `/api/*`. Defaults to `blockfrost` when a key is present, else the offline mock.
 */
let cached: DataProvider | undefined;

export function getDataProvider(): DataProvider {
  if (cached) return cached;
  cached = createDataProvider();
  return cached;
}

function createDataProvider(): DataProvider {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const which = process.env.DATA_PROVIDER ?? (projectId ? "blockfrost" : "mock");
  switch (which) {
    case "blockfrost":
      if (!projectId) {
        throw new Error(
          "DATA_PROVIDER=blockfrost but BLOCKFROST_PROJECT_ID is not set " +
            "(add it to .env.local for local dev, or the server env in prod).",
        );
      }
      return new BlockfrostDataProvider(projectId);
    // Next provider on the roadmap — our own Dolos node (no mortal dependency).
    // Implement DolosProvider (implements DataProvider) and add:
    //   case "dolos": return new DolosProvider(process.env.DOLOS_URL!);
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`unknown DATA_PROVIDER: ${which}`);
  }
}
