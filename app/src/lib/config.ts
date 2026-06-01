/**
 * App-wide configuration.
 *
 * The network is a SINGLE config value so the whole app is network-aware from
 * one place. ShaSwap's contracts are currently deployed on **preprod**, so that
 * is the default. Switch this (or set NEXT_PUBLIC_NETWORK) to retarget the UI.
 *
 * NOTE: this is presentation/wallet config only. All *chain data* must still go
 * through the data-access abstraction in `src/lib/data/` — nothing here reaches
 * a provider directly.
 */

export type Network = "preprod" | "preview" | "mainnet";

/** Cardano CIP-30 network id: 0 = testnet (preprod/preview), 1 = mainnet. */
export type NetworkId = 0 | 1;

const NETWORK: Network =
  (process.env.NEXT_PUBLIC_NETWORK as Network | undefined) ?? "preprod";

export const APP_CONFIG = {
  name: "ShaSwap",
  /** Active Cardano network. The one knob that makes the app network-aware. */
  network: NETWORK,
  /** CIP-30 network id derived from `network`. */
  networkId: (NETWORK === "mainnet" ? 1 : 0) as NetworkId,
} as const;

/** Human label for a network id, used in the header chip. */
export function networkLabel(network: Network = APP_CONFIG.network): string {
  return network.charAt(0).toUpperCase() + network.slice(1);
}
