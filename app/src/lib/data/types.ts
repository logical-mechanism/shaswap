/**
 * Domain types for the data-access abstraction.
 *
 * These are UI/domain shapes — deliberately decoupled from any provider's
 * on-the-wire format and from the on-chain datums. A provider implementation
 * is responsible for mapping its source (Koios / Blockfrost / Maestro / Kupo /
 * our own Dolos node / mock) into these types. Keep them small.
 */

/** A tradeable asset. ADA is represented with `unit: "lovelace"`. */
export interface TokenInfo {
  /** Canonical asset unit: "lovelace" for ADA, else `${policyId}${assetNameHex}`. */
  unit: string;
  /** Display ticker, e.g. "ADA", "TEST". */
  ticker: string;
  /** Full human name. */
  name: string;
  /** Decimal places for display (ADA = 6). */
  decimals: number;
  /** Optional icon URL / data-uri for the token chip. */
  icon?: string;
}

/** An ordered token pair, by unit. */
export interface Pair {
  a: string;
  b: string;
}

/** A liquidity pool: a pair plus its on-chain reserves and identity. */
export interface Pool {
  /** Pool identity — the pool NFT unit (policy+name) on Cardano. */
  id: string;
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  /** Reserve of tokenA, in base units (e.g. lovelace), as a decimal string. */
  reserveA: string;
  /** Reserve of tokenB, in base units, as a decimal string. */
  reserveB: string;
  /** Static trading fee as basis points (e.g. 30 = 0.30%). */
  feeBps: number;
}

/** A price quote for swapping `amountIn` of `tokenIn` into `tokenOut`. */
export interface Quote {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  /** Input amount in base units, as a decimal string. */
  amountIn: string;
  /** Estimated output amount in base units, as a decimal string. */
  amountOut: string;
  /** Mid price tokenOut-per-tokenIn, as a decimal string for display. */
  price: string;
  /** Price impact as a fraction (0.012 = 1.2%). */
  priceImpact: number;
  /** Pool the quote was computed against, if any. */
  poolId?: string;
}

/**
 * A user's intent to swap — what the UI would eventually hand to the
 * order-builder. In the skeleton this is read-only/illustrative; NO settlement
 * or tx is built from it yet.
 */
export interface OrderIntent {
  owner: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  /** Minimum acceptable output (the per-order floor / limit). */
  minOut: string;
  /** Optional posted solver tip, in lovelace. */
  tipLovelace?: string;
}

/** Status of an order/position as surfaced to the UI. */
export type OrderStatus = "open" | "settled" | "reclaimable";

/** A user's open order / position. */
export interface WalletPosition {
  /** The order's unique OutputReference, e.g. `${txHash}#${index}`. */
  ref: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  minOut: string;
  status: OrderStatus;
}
