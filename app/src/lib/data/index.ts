import type { DataProvider } from "./provider";
import { MockProvider } from "./mock";
import { BlockfrostDataProvider } from "./blockfrost";
import { log } from "../log";
import { APP_CONFIG, type Network } from "../config";

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

/**
 * The Cardano network a Blockfrost project id targets, inferred from its prefix
 * (`mainnet…` / `preprod…` / `preview…`). MeshJS's `BlockfrostProvider` keys off the same
 * prefix internally, so this is exactly what decides which chain the reads hit. Returns
 * `null` for a custom/self-hosted prefix we can't classify (don't block those).
 */
function keyNetwork(projectId: string): Network | null {
  for (const net of ["mainnet", "preprod", "preview"] as const) {
    if (projectId.startsWith(net)) return net;
  }
  return null;
}

export function getDataProvider(): DataProvider {
  if (cached) return cached;
  cached = createDataProvider();
  return cached;
}

function createDataProvider(): DataProvider {
  const projectId = process.env.BLOCKFROST_PROJECT_ID;
  const which = process.env.DATA_PROVIDER ?? (projectId ? "blockfrost" : "mock");

  // Refuse to serve FAKE pools/quotes in production by accident. The mock is fine for
  // local dev and explicit opt-in, but a prod deploy that simply forgot the Blockfrost
  // key would otherwise render a fully-functional-looking UI over fabricated data that
  // only breaks at tx-build time — the worst kind of silent failure for a DEX. Require
  // an explicit DATA_PROVIDER=mock to allow it in production.
  if (
    which === "mock" &&
    process.env.NODE_ENV === "production" &&
    process.env.DATA_PROVIDER !== "mock"
  ) {
    log.error("refusing MockProvider in production", { hint: "set BLOCKFROST_PROJECT_ID" });
    throw new Error(
      "Refusing to start with the MockProvider in production. Set BLOCKFROST_PROJECT_ID " +
        "(or another real DATA_PROVIDER), or set DATA_PROVIDER=mock to opt in explicitly.",
    );
  }

  // One-time startup signal of the active backend (helps catch a mock-in-prod misconfig).
  log.info("data provider selected", { provider: which });

  switch (which) {
    case "blockfrost": {
      if (!projectId) {
        throw new Error(
          "DATA_PROVIDER=blockfrost but BLOCKFROST_PROJECT_ID is not set " +
            "(add it to .env.local for local dev, or the server env in prod).",
        );
      }
      // The key's network MUST match NEXT_PUBLIC_NETWORK. Blockfrost infers the chain from
      // the key prefix, so a mainnet app left on a preprod key (or vice-versa) would
      // silently read the WRONG chain. Compare network NAMES, not ids: preprod and preview
      // both map to networkId 0, so an id check would miss a preprod↔preview swap. An
      // unclassifiable prefix (self-hosted / future Dolos) is allowed through.
      const keyNet = keyNetwork(projectId);
      if (keyNet && keyNet !== APP_CONFIG.network) {
        log.error("Blockfrost key/network mismatch", {
          appNetwork: APP_CONFIG.network,
          keyNetwork: keyNet,
        });
        throw new Error(
          `BLOCKFROST_PROJECT_ID is a ${keyNet} key but NEXT_PUBLIC_NETWORK=${APP_CONFIG.network}. ` +
            "These must match — refusing to start to avoid reading the wrong chain.",
        );
      }
      return new BlockfrostDataProvider(projectId);
    }
    // Next provider on the roadmap — our own Dolos node (no mortal dependency).
    // Implement DolosProvider (implements DataProvider) and add:
    //   case "dolos": return new DolosProvider(process.env.DOLOS_URL!);
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`unknown DATA_PROVIDER: ${which}`);
  }
}
