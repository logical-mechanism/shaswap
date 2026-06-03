/**
 * Pure ADA-funding arithmetic for posting an order — extracted from `SwapCard` so the
 * spendable / over-balance / insufficient-ADA logic is unit-testable in isolation (the
 * card itself can't be loaded by the Node test runner: MeshJS + the `@/` alias).
 *
 * The three roles ADA can play in one order (BLUEPRINT §5.2.1) make this fiddly:
 *  - the **traded** side (when selling ADA, the sold lovelace),
 *  - the per-order **min-ADA** the UTXO must carry (doubled for a partial fill, which
 *    leaves a second reclaimable output — mirrors `order.ts`'s `(partial?2:1)×min`),
 *  - the solver **tip** (separate ADA on top),
 * plus a network-fee buffer. When the *sold* asset is ADA, all of that must come out of
 * the same lovelace balance — so MAX/Half must hold the overhead back or they build a tx
 * the wallet can't submit. When the sold asset is a token, the overhead is funded from
 * the wallet's *separate* ADA, so we check that ADA is sufficient up front.
 */

import { ORDER_MIN_ADA } from "./deployment.ts";

/** Network-fee headroom held back on top of the order min-ADA + tip. ~1 ₳. */
export const ORDER_FEE_BUFFER = 1_000_000n;

export interface OrderFundingInput {
  /** Whether the asset being SOLD is ADA (lovelace). */
  fromIsAda: boolean;
  /** Wallet balance of the FROM token (lovelace when selling ADA), base units. */
  fromBalance: bigint;
  /** Wallet ADA (lovelace) balance — funds min-ADA + tip + fee on a non-ADA sale. */
  lovelace: bigint;
  /** Partial fills allowed → the order pre-funds 2× order_min_ada. */
  partial: boolean;
  /** Solver tip, in lovelace (≥ 0). */
  tip: bigint;
  /** Sell amount in base units (0 when no/invalid amount is entered). */
  amount: bigint;
}

export interface OrderFunding {
  /** Order min-ADA: `order_min_ada`, doubled for a partial. */
  orderMinAda: bigint;
  /** Non-tip ADA overhead = order min-ADA + fee buffer. */
  adaNeeded: bigint;
  /** ADA held back from a from=ADA balance so MAX can't build an un-submittable tx. */
  adaReserve: bigint;
  /** Total ADA the wallet must hold to fund a non-ADA sale (min-ADA + fee + tip). */
  adaForOrder: bigint;
  /** Most of the FROM token actually spendable (ADA: balance − reserve, floored at 0). */
  spendable: bigint;
  /** Amount exceeds the raw FROM balance. */
  overBalance: boolean;
  /** Within balance but over spendable (the held-back ADA reserve eats the rest). */
  overSpendable: boolean;
  /** Selling a non-ADA token but the wallet lacks the ADA for min-ADA + fee + tip. */
  insufficientAda: boolean;
}

/**
 * Derive the spendable amount + the three funding blockers for an order, from the
 * wallet's balances and the order's shape. Does NOT gate on wallet connectivity — the
 * caller ANDs the booleans with `connected`. `amount` of 0 means "no amount entered",
 * which makes every blocker false (nothing to fund yet).
 */
export function orderFunding(i: OrderFundingInput): OrderFunding {
  const orderMinAda = (i.partial ? 2n : 1n) * ORDER_MIN_ADA;
  const adaNeeded = orderMinAda + ORDER_FEE_BUFFER;
  // Selling ADA: the tip is also drawn from this balance, so reserve it too.
  const adaReserve = adaNeeded + (i.fromIsAda ? i.tip : 0n);
  const adaForOrder = adaNeeded + i.tip;
  const spendable = i.fromIsAda
    ? i.fromBalance > adaReserve
      ? i.fromBalance - adaReserve
      : 0n
    : i.fromBalance;

  const has = i.amount > 0n;
  const overBalance = has && i.amount > i.fromBalance;
  const overSpendable = has && !overBalance && i.amount > spendable;
  const insufficientAda = !i.fromIsAda && has && i.lovelace < adaForOrder;

  return {
    orderMinAda,
    adaNeeded,
    adaReserve,
    adaForOrder,
    spendable,
    overBalance,
    overSpendable,
    insufficientAda,
  };
}
