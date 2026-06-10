import type { UTxO } from "@meshsdk/core";
import type {
  LpIntentPosition,
  Pool,
  Quote,
  ReferencePrice,
  Route,
  TokenInfo,
  WalletPosition,
} from "@/lib/data";

/**
 * Client-side fetch helpers.
 *
 * These hit our OWN `/api/*` route handlers — which is the only way the browser
 * touches chain data. The client never imports a provider SDK or the data
 * abstraction directly; that all lives server-side behind the routes.
 */

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): ${url}`);
  }
  return (await res.json()) as T;
}

export async function fetchTokens(signal?: AbortSignal): Promise<TokenInfo[]> {
  const { tokens } = await getJson<{ tokens: TokenInfo[] }>(
    "/api/tokens",
    signal,
  );
  return tokens;
}

export async function fetchPools(signal?: AbortSignal): Promise<Pool[]> {
  const { pools } = await getJson<{ pools: Pool[] }>("/api/pools", signal);
  return pools;
}

/**
 * Filter a wallet's held asset units to the ones in the off-chain token registry (CIP-26),
 * returning their `TokenInfo`. Used by Create-Pool so its picker shows registered fungible
 * tokens, not NFT clutter. POSTs the units (a wallet can hold too many for a query string).
 */
export async function fetchRegisteredTokens(
  units: string[],
  signal?: AbortSignal,
): Promise<TokenInfo[]> {
  const res = await fetch("/api/asset-meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ units }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): /api/asset-meta`);
  }
  const { tokens } = (await res.json()) as { tokens: TokenInfo[] };
  return tokens;
}

export async function fetchQuote(
  inUnit: string,
  outUnit: string,
  amount: string,
  signal?: AbortSignal,
): Promise<Quote | null> {
  const qs = new URLSearchParams({ in: inUnit, out: outUnit, amount });
  const { quote } = await getJson<{ quote: Quote | null }>(
    `/api/quote?${qs.toString()}`,
    signal,
  );
  return quote;
}

/**
 * The best SPLIT route for a swap: how to spread `amount` across the pair's sharded pools
 * to maximise output, gated by the per-leg solver `tip` (lovelace). A one-leg route is the
 * single-best-pool case; null when no pool trades the pair. Read THROUGH our /api/route —
 * never a provider SDK.
 */
export async function fetchRoute(
  inUnit: string,
  outUnit: string,
  amount: string,
  tip: string,
  signal?: AbortSignal,
): Promise<Route | null> {
  const qs = new URLSearchParams({ in: inUnit, out: outUnit, amount, tip });
  const { route } = await getJson<{ route: Route | null }>(
    `/api/route?${qs.toString()}`,
    signal,
  );
  return route;
}

/**
 * A non-binding external market reference (human tokenB per 1 tokenA), or null when
 * unavailable. Used to suggest a first-deposit opening price. The user still sets the price.
 */
export async function fetchReferencePrice(
  tokenAUnit: string,
  tokenBUnit: string,
  signal?: AbortSignal,
): Promise<ReferencePrice | null> {
  const qs = new URLSearchParams({ a: tokenAUnit, b: tokenBUnit });
  const { reference } = await getJson<{ reference: ReferencePrice | null }>(
    `/api/reference-price?${qs.toString()}`,
    signal,
  );
  return reference;
}

export async function fetchOrders(
  address: string,
  signal?: AbortSignal,
): Promise<WalletPosition[]> {
  const qs = new URLSearchParams({ address });
  const { orders } = await getJson<{ orders: WalletPosition[] }>(
    `/api/orders?${qs.toString()}`,
    signal,
  );
  return orders;
}

export async function fetchLpIntents(
  address: string,
  signal?: AbortSignal,
): Promise<LpIntentPosition[]> {
  const qs = new URLSearchParams({ address });
  const { intents } = await getJson<{ intents: LpIntentPosition[] }>(
    `/api/lp-intents?${qs.toString()}`,
    signal,
  );
  return intents;
}

/**
 * Whether a tx has CONFIRMED on-chain (in a block) — via the seam. The Orders view uses
 * this to verify an optimistic reclaim actually landed before trusting it (a reclaim can
 * lose a mempool race to a solver settlement and never confirm). A 502 (transient provider
 * error) throws — the caller should keep the optimistic state and retry, never read the
 * failure as "didn't land".
 */
export async function fetchTxConfirmed(
  txHash: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const qs = new URLSearchParams({ tx: txHash });
  const { confirmed } = await getJson<{ confirmed: boolean }>(
    `/api/tx/status?${qs.toString()}`,
    signal,
  );
  return confirmed;
}

/**
 * Resolve the live pool UTXO (value + inline `PoolDatum` CBOR) for a pool, by its NFT
 * unit. Used by the LP manage page to read current reserves / circulating LP for the
 * deposit/withdraw previews. Returns null if no live pool UTXO holds that NFT.
 */
export async function fetchPoolUtxo(
  nftUnit: string,
  signal?: AbortSignal,
): Promise<UTxO | null> {
  const qs = new URLSearchParams({ nft: nftUnit });
  const { utxo } = await getJson<{ utxo: UTxO | null }>(
    `/api/tx/pool-utxo?${qs.toString()}`,
    signal,
  );
  return utxo;
}
