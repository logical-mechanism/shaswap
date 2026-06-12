/**
 * Min-out (owner-floor) quotes for the two LP intents — the TS mirror of the batcher's pin
 * generator `batcher/crates/solver-core/src/lp.rs` (`withdraw_amounts` / `deposit_plan`) and
 * the on-chain `lp_intent.fulfill` floor checks.
 *
 * The FAIR amount an honest batcher fulfills is rounded the pool's favor (floor of the
 * proportional share), exactly as the pool's per-share-backing inequality requires:
 *  - withdraw: `released_x = floor(L · res_x / circ)` per asset;
 *  - deposit:  `shares = min(floor(dA · circ / res_a), floor(dB · circ / res_b))`.
 *
 * The owner FLOOR pinned in the datum is then `floor(fair · (1 − slippage))` — a SECOND
 * downward round — so it is always `≤` the fair amount the batcher computes from the same
 * reserves. An honest batcher therefore always clears the floor; if the reserves move
 * adversely between quote and fulfillment, the floor is the owner's slippage protection.
 * Computed from reserves resolved through the data seam (`usePoolUtxo` → `/api/tx/pool-utxo`);
 * the math itself is pure (no provider) and unit-tested against the Rust fixtures.
 */

import type { PoolStats } from "./lp.ts";
import { MIN_LIQ } from "./deployment.ts";

/**
 * Apply a slippage haircut (percent) to a fair amount, flooring. Clamped to [0, 100%].
 * Identical to `LiquidityPanel.withSlippage` (the direct path) so the two LP modes round
 * a floor the same way.
 */
export function withSlippage(amount: bigint, slippagePct: number): bigint {
  const bps = BigInt(Math.min(10_000, Math.max(0, Math.round(slippagePct * 100))));
  return (amount * (10_000n - bps)) / 10_000n;
}

export interface DepositQuote {
  /** Fair LP the batcher would mint for `(amountA, amountB)` (matches Rust `deposit_plan`). */
  fairShares: bigint;
  /** Conservative owner floor pinned in the datum (`≤ fairShares`). */
  minShares: bigint;
}

/**
 * Quote a DEPOSIT intent's `min_shares` floor. First deposit (`circ == 0`) is excluded — the
 * creator seeds directly via the existing `LpAction` path (spec §"Deposit fulfill"). Throws on
 * a degenerate pool or a dust deposit that can't guarantee ≥ 1 LP at this slippage.
 */
export function quoteLpDeposit(
  stats: PoolStats,
  amountA: bigint,
  amountB: bigint,
  slippagePct: number,
): DepositQuote {
  if (stats.circ <= 0n) {
    throw new Error(
      "first deposit is not intent-fulfillable: seed this pool via the Direct path",
    );
  }
  if (amountA <= 0n || amountB <= 0n) {
    throw new Error("deposit amounts must be positive on both sides");
  }
  if (stats.resA <= 0n || stats.resB <= 0n) {
    throw new Error("pool reserves must be positive");
  }
  const sharesA = (amountA * stats.circ) / stats.resA; // floor
  const sharesB = (amountB * stats.circ) / stats.resB; // floor
  const fairShares = sharesA < sharesB ? sharesA : sharesB;
  if (fairShares < 1n) throw new Error("deposit too small: would mint no LP");
  const minShares = withSlippage(fairShares, slippagePct);
  if (minShares < 1n) {
    throw new Error("deposit too small for this slippage: would not guarantee any LP");
  }
  return { fairShares, minShares };
}

export interface WithdrawQuote {
  /** Fair released `asset_a` (matches Rust `withdraw_amounts`). */
  fairA: bigint;
  /** Fair released `asset_b`. */
  fairB: bigint;
  /** Conservative owner floor on `asset_a` (`≤ fairA`). */
  minA: bigint;
  /** Conservative owner floor on `asset_b` (`≤ fairB`). */
  minB: bigint;
}

/**
 * Quote a WITHDRAW intent's `min_a`/`min_b` floors. The redeemed `lpAmount` must leave
 * `circ_out ≥ MIN_LIQ` (the pool `LpAction` rejects otherwise — the same cap the Direct
 * withdraw form enforces). Throws on a degenerate pool or a dust withdraw.
 */
export function quoteLpWithdraw(
  stats: PoolStats,
  lpAmount: bigint,
  slippagePct: number,
): WithdrawQuote {
  if (stats.circ <= 0n) throw new Error("pool has no circulating LP to withdraw");
  if (lpAmount < 1n) throw new Error("withdraw amount must be at least 1");
  if (lpAmount > stats.circ) throw new Error("cannot withdraw more LP than circulating");
  if (stats.circ - lpAmount < MIN_LIQ) {
    throw new Error(
      `withdraw would drop circulating LP below the locked minimum (${MIN_LIQ})`,
    );
  }
  const fairA = (lpAmount * stats.resA) / stats.circ; // floor
  const fairB = (lpAmount * stats.resB) / stats.circ; // floor
  if (fairA <= 0n && fairB <= 0n) {
    throw new Error("withdraw too small: rounds to zero on both sides");
  }
  const minA = withSlippage(fairA, slippagePct);
  const minB = withSlippage(fairB, slippagePct);
  if (minA <= 0n && minB <= 0n) {
    throw new Error("withdraw too small for this slippage: no guaranteed output");
  }
  return { fairA, fairB, minA, minB };
}
