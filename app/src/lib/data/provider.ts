import type {
  Pool,
  Quote,
  TokenInfo,
  WalletPosition,
} from "./types";

/**
 * The data-access abstraction (CLAUDE.md HARD RULE).
 *
 * Every read of chain data goes through THIS interface. No component, hook, or
 * route handler may call a specific provider (Koios / Blockfrost / Maestro /
 * Kupo / Ogmios / our own Dolos node) directly. Swapping the backing data
 * source — including moving to our own node later — must be a one-file change:
 * point `getDataProvider()` (see ./index.ts) at a different implementation.
 *
 * Implementations live server-side and are invoked from Next route handlers
 * (`src/app/api/.../route.ts`) so provider credentials never reach the client.
 * The client only ever talks to our own `/api/*`.
 *
 * Keep this surface small and domain-typed.
 */
export interface DataProvider {
  /** Human name of the backing implementation (for diagnostics). */
  readonly name: string;

  /** Tokens known to the UI (for selectors). */
  listTokens(): Promise<TokenInfo[]>;

  /** All known liquidity pools. */
  listPools(): Promise<Pool[]>;

  /** A single pool by its id (pool NFT unit), or null if absent. */
  getPool(poolId: string): Promise<Pool | null>;

  /**
   * A price quote for swapping `amountIn` (base units) of `tokenInUnit` into
   * `tokenOutUnit`. Returns null when no pool/quote is available.
   *
   * Skeleton note: the MockProvider computes this with a plain constant-product
   * curve purely so the UI renders a number. It is NOT the protocol's clearing
   * math and builds nothing on-chain.
   */
  priceQuote(
    tokenInUnit: string,
    tokenOutUnit: string,
    amountIn: string,
  ): Promise<Quote | null>;

  /** A wallet's open orders / positions for a bech32 address. */
  walletPositions(address: string): Promise<WalletPosition[]>;
}
