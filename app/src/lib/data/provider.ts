import type { Action, Protocol, UTxO } from "@meshsdk/core";
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

  /**
   * Current protocol parameters — needed client-side by `MeshTxBuilder` for fee
   * calculation. Served via `/api/protocol-params` so the provider key stays on the
   * server; the browser passes the result to the builder, never touching a provider.
   */
  protocolParameters(): Promise<Protocol>;

  /**
   * Script execution units for a draft tx (the Plutus `Reclaim` spend). Served via
   * `/api/tx/evaluate`; the client feeds the result to `MeshTxBuilder`'s evaluator.
   */
  evaluateTx(txCbor: string): Promise<Omit<Action, "data">[]>;

  /**
   * Resolve a single UTXO by output reference — used to fetch the on-chain order
   * UTXO (value + inline datum) the reclaim builder spends. Served via
   * `/api/tx/utxo`. Returns null if it is already spent / not found.
   */
  resolveUtxo(txHash: string, index: number): Promise<UTxO | null>;

  /**
   * Resolve the live pool UTXO (value + inline `PoolDatum`) for a pool, by its NFT
   * unit (`policy+name`, the pool id). Used by the LP deposit/withdraw builders to
   * spend the pool on the `LpAction` path. Served via `/api/tx/pool-utxo`. Returns
   * null if no live UTXO at the pool address holds that NFT (1) with a decodable datum.
   */
  resolvePoolUtxo(poolNftUnit: string): Promise<UTxO | null>;
}
