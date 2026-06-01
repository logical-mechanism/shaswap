import type { Pool, Quote, TokenInfo, WalletPosition } from "@/lib/data";

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
