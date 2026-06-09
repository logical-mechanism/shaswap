import type { Action, Protocol, UTxO } from "@meshsdk/core";
import type {
  LpIntentPosition,
  Pool,
  Quote,
  ReferencePrice,
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

  /**
   * Filter a set of asset units (typically a wallet's holdings) down to the ones in the
   * off-chain token registry (CIP-26) — real fungible tokens with registry metadata —
   * returning their `TokenInfo`. NFTs and unregistered assets are dropped. Used by
   * Create-Pool so the picker shows registered tokens instead of a wallet's NFT clutter.
   * `lovelace` is ignored (the caller adds ADA itself); unknown/transient lookups are
   * treated as "not registered" and omitted.
   */
  listRegisteredTokens(units: string[]): Promise<TokenInfo[]>;

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

  /**
   * A non-binding external market reference price for a pair (human tokenB per 1 tokenA),
   * or null when unavailable (no market / external source down / non-mainnet network). Used
   * only to suggest a sane opening price on a pool's first deposit — an app convenience, NOT
   * a core dependency: the protocol never reads it and the UI works fine without it.
   */
  referencePrice(
    tokenAUnit: string,
    tokenBUnit: string,
  ): Promise<ReferencePrice | null>;

  /** A wallet's open orders / positions for a bech32 address. */
  walletPositions(address: string): Promise<WalletPosition[]>;

  /**
   * A wallet's open batcher-fulfilled LP intents (deposit/withdraw) for a bech32 address —
   * the live UTXOs at the `lp_intent` address owned by this wallet's payment key. Mirrors
   * `walletPositions` for the LP-intent surface (pending/reclaim). Empty on a network where
   * the LP-intent path isn't live (the address resolves but holds nothing).
   */
  walletLpIntents(address: string): Promise<LpIntentPosition[]>;

  /**
   * Current protocol parameters — needed client-side by `MeshTxBuilder` for fee
   * calculation. Served via `/api/protocol-params` so the provider key stays on the
   * server; the browser passes the result to the builder, never touching a provider.
   */
  protocolParameters(): Promise<Protocol>;

  /**
   * The network's current Plutus cost models as ordered parameter arrays
   * `[plutusV1, plutusV2, plutusV3]`. The MeshJS `Protocol` type drops these, but they
   * are required to compute a Plutus spend's script-integrity hash that matches the
   * node — MeshJS otherwise uses stale baked-in defaults and the node rejects the tx.
   * Served via `/api/protocol-params` alongside the params.
   */
  costModels(): Promise<number[][]>;

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
   * Whether a transaction is CONFIRMED on-chain (in a block), not merely submitted.
   *
   * The Orders view reconciles an optimistic reclaim with this: a reclaim and a solver
   * settlement BOTH spend the order UTXO, so the order disappearing can't reveal which
   * one won — only the reclaim tx hash being on-chain proves the reclaim actually landed
   * (vs. losing a mempool race to a settlement — a double-spend that never confirms).
   * `false` means not-yet/never confirmed; a transient provider failure throws (so the
   * caller can retry rather than wrongly conclude "not confirmed"). Served via
   * `/api/tx/status`.
   */
  transactionConfirmed(txHash: string): Promise<boolean>;

  /**
   * Resolve the live pool UTXO (value + inline `PoolDatum`) for a pool, by its NFT
   * unit (`policy+name`, the pool id). Used by the LP deposit/withdraw builders to
   * spend the pool on the `LpAction` path. Served via `/api/tx/pool-utxo`. Returns
   * null if no live UTXO at the pool address holds that NFT (1) with a decodable datum.
   */
  resolvePoolUtxo(poolNftUnit: string): Promise<UTxO | null>;

  /**
   * The input `OutputReference`s of the transaction that minted a pool (by its NFT
   * unit). The pool's one-shot `pool_mint(seed)` seed is one of these inputs; the
   * client recovers it by testing which input reproduces the pool's policy id (pure
   * `applyParamsToScript`/`resolveScriptHash`, off the seam). Needed to close a
   * never-seeded pool (burn NFT + LP under the seed-applied policy). Served via
   * `/api/pool/mint-inputs`. Empty array if the mint tx can't be resolved.
   */
  poolMintInputs(poolNftUnit: string): Promise<{ txHash: string; index: number }[]>;
}
