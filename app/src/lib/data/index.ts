import type { DataProvider } from "./provider";
import { MockProvider } from "./mock";

export type { DataProvider } from "./provider";
export type * from "./types";

/**
 * THE single swap point for the data-access abstraction.
 *
 * To move from mock data to a real source (Koios / Blockfrost / Maestro / our
 * own Dolos node), implement `DataProvider` in a new file under this folder and
 * return it here — keyed off an env var. That is the ONLY edit required; every
 * route handler and hook goes through this function, so no caller changes.
 *
 * This runs server-side (called from route handlers), so any future provider
 * keys read here stay off the client.
 */
let cached: DataProvider | undefined;

export function getDataProvider(): DataProvider {
  if (cached) return cached;

  // const which = process.env.DATA_PROVIDER ?? "mock";
  // switch (which) {
  //   case "blockfrost": cached = new BlockfrostProvider(process.env.BLOCKFROST_KEY!); break;
  //   case "dolos":      cached = new DolosProvider(process.env.DOLOS_URL!); break;
  //   default:           cached = new MockProvider();
  // }
  cached = new MockProvider();
  return cached;
}
