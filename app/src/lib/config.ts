/**
 * App-wide configuration.
 *
 * The network is a SINGLE config value so the whole app is network-aware from
 * one place. ShaSwap's contracts are live on **mainnet** and **preprod**; this
 * falls back to **preprod** when `NEXT_PUBLIC_NETWORK` is unset (a safe local-dev
 * default — production sets it to `mainnet`). Set `NEXT_PUBLIC_NETWORK` to retarget the UI.
 *
 * NOTE: this is presentation/wallet config only. All *chain data* must still go
 * through the data-access abstraction in `src/lib/data/` — nothing here reaches
 * a provider directly.
 */

export type Network = "preprod" | "preview" | "mainnet";

/**
 * Cardano CIP-30 network id: 0 = testnet (preprod AND preview), 1 = mainnet.
 *
 * NOTE: this is the only network signal a wallet exposes via CIP-30, and it can NOT
 * distinguish preprod from preview — both report 0. So the app's wrong-network gate can
 * only catch mainnet↔testnet mismatches; a preview wallet on a preprod deployment passes
 * the id check. We surface a contextual caution in the connected-wallet menu rather than
 * claim false precision (see WalletBar). Precise detection would need the network magic,
 * which isn't in the CIP-30 base API.
 */
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

/** Cardanoscan base URL for the active network (mainnet has no subdomain). */
function explorerBase(network: Network = APP_CONFIG.network): string {
  return network === "mainnet"
    ? "https://cardanoscan.io"
    : `https://${network}.cardanoscan.io`;
}

/** Link to a transaction on the active network's block explorer. */
export function explorerTxUrl(
  txHash: string,
  network: Network = APP_CONFIG.network,
): string {
  return `${explorerBase(network)}/transaction/${txHash}`;
}
