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
  /**
   * True when the pool has never been seeded — no circulating LP (held == total_lp), so
   * the next deposit is the seeding first deposit. Derived at the data seam from the pool
   * UTXO; lets the UI flag empty pools instead of showing them as `0 / 0` live pools.
   */
  firstDeposit?: boolean;
}

/**
 * A non-binding market-price reference for a pair, sourced from an external DEX (app-only;
 * the CORE never depends on it). Used to suggest a sane opening price on a pool's first
 * deposit — the user still sets the real price.
 */
export interface ReferencePrice {
  /** How many tokenB are worth 1 tokenA, in HUMAN units (decimal-adjusted). */
  pricePerA: number;
  /** Human name of the external source (e.g. "MuesliSwap"). */
  source: string;
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
  /** Whether the order allows partial fills (a partial leaves a reclaimable remainder). */
  partial: boolean;
  /**
   * Optional settle-by deadline (POSIX ms), decoded from the order datum, or null. A solver
   * can only settle the order before this; past it the order just rests, owner-reclaimable.
   * Surfaced so a resting order reads as a finite, cozy wait rather than open-ended.
   */
  deadline: string | null;
}

/** Which LP action an intent requests. Mirrors `LpIntentAction` on-chain. */
export type LpIntentKind = "deposit" | "withdraw";

/**
 * A user's open batcher-fulfilled LP intent (BLUEPRINT §5.1 Rev 22), decoded from a live
 * UTXO at the `lp_intent` address. The amounts are display-ready (the ADA triple-role on a
 * deposit is already disambiguated against the pool pair); the row layer derives pending/
 * completed/reclaimed by merging this with the local activity log, like orders.
 */
export interface LpIntentPosition {
  /** The intent's unique OutputReference, `${txHash}#${index}`. */
  ref: string;
  /** Pool NFT unit (policy+name) the intent binds. */
  poolNft: string;
  action: LpIntentKind;
  /** The pool's pair (placeholders for an orphan intent whose pool isn't on-chain). */
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  /** Deposit: `asset_a` / `asset_b` being added (base units). Absent on a withdraw. */
  depositA?: string;
  depositB?: string;
  /** Withdraw: LP tokens being redeemed (base units). Absent on a deposit. */
  lp?: string;
  /** Owner floor: min released `asset_a` (withdraw); 0 on a deposit. Base units. */
  minA: string;
  /** Owner floor: min released `asset_b` (withdraw); 0 on a deposit. */
  minB: string;
  /** Owner floor: min LP minted (deposit); 0 on a withdraw. */
  minShares: string;
  /** Solver tip (lovelace) — the only value the batcher keeps. */
  tip: string;
  /** Optional fulfillment deadline (POSIX ms), or null. */
  deadline: string | null;
}
