/**
 * Pure LP deposit/withdraw builders — the TS mirror of `spend.lp_action`
 * (`contracts/lib/shaswap/spend.ak`, BLUEPRINT §6, Rev 7). Given the pool's current
 * UTXO value + its `PoolDatum`, these compute the integer share math (floor
 * everything, exactly like the validator) and return the **recreated pool output
 * value** plus the amounts the depositor/withdrawer nets. No wallet/IO — the MeshJS
 * tx wiring lives in `lib/client/tx.ts`; this is the math + value layout + strict
 * validation, so it is unit-testable (against the `lp_test.ak` fixtures) and a
 * malformed intent is *rejected here*, never silently built into a doomed tx.
 *
 * The validator is fully value-derived:
 *  - reserves come from the pool value (ADA side carries `pool_min_ada` overhead);
 *  - LP circulating supply = `total_lp − (LP held in the pool UTXO)`;
 *  - LP only MOVES pool<->user (`tx.mint == 0`) — deposit lowers `held`, withdraw
 *    raises it; the difference is the depositor's/withdrawer's LP.
 *
 * The on-chain checks this must satisfy (per-share reserve backing non-decreasing in
 * BOTH assets) hold because every share/return is FLOORED:
 *  - subsequent deposit: `lp_to_user = min(⌊Δa·circ/res_a⌋, ⌊Δb·circ/res_b⌋)`;
 *  - subsequent withdraw: `recv_x = ⌊burn·res_x/circ⌋`;
 *  - first deposit (`circ == 0`): `circ_out = ⌊√(res_a_out·res_b_out)⌋`, with exactly
 *    `min_liq` LP locked at `Script(nft.policy)` (the caller adds that output).
 */

import type { Asset } from "@meshsdk/core";
import { assetUnit, isAda, type PoolDatum } from "./datums.ts";
import { lpUnitForPool, MIN_LIQ, POOL_MIN_ADA, TOTAL_LP } from "./deployment.ts";

/** A resolved pool UTXO: its value and decoded inline `PoolDatum`. */
export interface PoolView {
  value: Asset[];
  datum: PoolDatum;
}

/** Pool accounting derived from the value + datum (all base units). */
export interface PoolStats {
  /** Reserve of `asset_a` (ADA side carries `pool_min_ada` carved out). */
  resA: bigint;
  /** Reserve of `asset_b`. */
  resB: bigint;
  /** LP held in the pool UTXO. */
  held: bigint;
  /** Circulating LP = `total_lp − held`. */
  circ: bigint;
  /** This pool's LP-token unit (`nft.policy + 4c50`). */
  lpUnit: string;
  /** This pool's NFT unit. */
  nftUnit: string;
  /** True when `circ == 0` — the next deposit is the seeding first deposit. */
  firstDeposit: boolean;
}

export interface BuiltDeposit {
  firstDeposit: boolean;
  /** LP the depositor receives (first deposit nets `circ_out − min_liq`). */
  lpToUser: bigint;
  /** Resulting circulating LP. */
  circOut: bigint;
  /** The recreated pool output value (reserves +Δ, `held_out` LP, NFT preserved). */
  poolValue: Asset[];
  /** On the first deposit, the `min_liq` LP the caller must lock at `Script(nft.policy)`. */
  lockLp: bigint | null;
}

export interface BuiltWithdraw {
  /** `asset_a` returned to the user. */
  recvA: bigint;
  /** `asset_b` returned to the user. */
  recvB: bigint;
  /** Resulting circulating LP. */
  circOut: bigint;
  /** The recreated pool output value (reserves −recv, `held_out` LP, NFT preserved). */
  poolValue: Asset[];
}

// ---- value helpers (Mesh `Asset[]`; quantities are decimal strings) ----

/** Quantity of `unit` in a value, as bigint (0 if absent). */
function qtyOfUnit(value: Asset[], unit: string): bigint {
  const f = value.find((a) => a.unit === unit);
  return f ? BigInt(f.quantity) : 0n;
}

/** Return a copy of `value` with `unit` set to exactly `qty` (drops a non-ADA zero). */
function setUnit(value: Asset[], unit: string, qty: bigint): Asset[] {
  if (qty < 0n) throw new Error(`negative quantity for ${unit}`);
  const out = value
    .filter((a) => a.unit !== unit)
    .map((a) => ({ unit: a.unit, quantity: a.quantity }));
  // Never drop lovelace (a UTXO always carries it); drop a token that hits zero.
  if (qty > 0n || unit === "lovelace") {
    out.push({ unit, quantity: qty.toString() });
  }
  return out;
}

/** Add `delta` (signed) to `unit`'s quantity; throws on underflow. */
function addUnit(value: Asset[], unit: string, delta: bigint): Asset[] {
  const next = qtyOfUnit(value, unit) + delta;
  if (next < 0n) throw new Error(`value underflow for ${unit}`);
  return setUnit(value, unit, next);
}

/** Apply a signed reserve delta to a pool's value (ADA → lovelace; token → its unit). */
function addReserve(value: Asset[], asset: PoolDatum["assetA"], delta: bigint): Asset[] {
  return addUnit(value, isAda(asset) ? "lovelace" : assetUnit(asset), delta);
}

/** Reserve of `asset` in a pool value: its quantity, minus `pool_min_ada` if it is ADA. */
function reserveOf(value: Asset[], asset: PoolDatum["assetA"]): bigint {
  const q = qtyOfUnit(value, isAda(asset) ? "lovelace" : assetUnit(asset));
  return isAda(asset) ? q - POOL_MIN_ADA : q;
}

/** Integer floor square root (Newton). `n ≥ 0`. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** `⌈a/b⌉` for positive `b`. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv by non-positive");
  return (a + b - 1n) / b;
}

/** Derive pool accounting from a resolved pool UTXO. Throws if it isn't a sane pool. */
export function poolStats(view: PoolView): PoolStats {
  const nftUnit = assetUnit(view.datum.nft);
  const lpUnit = lpUnitForPool(nftUnit);
  if (qtyOfUnit(view.value, nftUnit) !== 1n) {
    throw new Error("pool UTXO must hold exactly 1 NFT");
  }
  const resA = reserveOf(view.value, view.datum.assetA);
  const resB = reserveOf(view.value, view.datum.assetB);
  const held = qtyOfUnit(view.value, lpUnit);
  if (resA < 0n || resB < 0n) throw new Error("pool reserves are negative");
  if (held < 0n || held > TOTAL_LP) throw new Error("pool LP held out of range");
  const circ = TOTAL_LP - held;
  return { resA, resB, held, circ, lpUnit, nftUnit, firstDeposit: circ === 0n };
}

/**
 * For a subsequent (proportional) deposit, the `asset_b` amount to pair with `deltaA`:
 * `Δb = ⌈Δa·res_b/res_a⌉`. Rounding UP keeps the deposit at-or-above the pool ratio so
 * the per-share backing holds on both sides. Not used for the first deposit (any ratio).
 */
export function pairDeltaB(stats: PoolStats, deltaA: bigint): bigint {
  if (deltaA <= 0n) throw new Error("deltaA must be positive");
  if (stats.resA <= 0n) throw new Error("cannot pair against a zero asset_a reserve");
  return ceilDiv(deltaA * stats.resB, stats.resA);
}

/**
 * Build a deposit. `deltaA`/`deltaB` are the asset_a/asset_b amounts the user funds.
 * `minLpOut` (optional) is a client-side slippage guard: throw if the freshly-computed
 * LP is below it (the pool may have moved since the preview). Returns the recreated
 * pool value; on the first deposit, `lockLp = min_liq` and the depositor nets
 * `circ_out − min_liq` (the caller adds the `Script(nft.policy)` lock output).
 */
export function buildDeposit(args: {
  view: PoolView;
  deltaA: bigint;
  deltaB: bigint;
  minLpOut?: bigint;
}): BuiltDeposit {
  const { view, deltaA, deltaB, minLpOut } = args;
  const s = poolStats(view);
  if (deltaA <= 0n || deltaB <= 0n) {
    throw new Error("deposit amounts must be positive on both sides");
  }

  const resAout = s.resA + deltaA;
  const resBout = s.resB + deltaB;

  let circOut: bigint;
  let lpToUser: bigint;
  let lockLp: bigint | null;

  if (s.firstDeposit) {
    if (resAout <= 0n || resBout <= 0n) {
      throw new Error("first deposit: both reserves must be positive");
    }
    circOut = isqrt(resAout * resBout);
    // mirror math.is_sqrt: circ_out² ≤ P < (circ_out+1)²
    const p = resAout * resBout;
    if (!(circOut * circOut <= p && (circOut + 1n) * (circOut + 1n) > p)) {
      throw new Error("internal: isqrt failed the is_sqrt invariant");
    }
    if (!(circOut > MIN_LIQ)) {
      throw new Error("first deposit too small: circulating LP must exceed min_liq");
    }
    lockLp = MIN_LIQ;
    lpToUser = circOut - MIN_LIQ;
  } else {
    const lpA = (deltaA * s.circ) / s.resA; // floor
    const lpB = (deltaB * s.circ) / s.resB; // floor
    lpToUser = lpA < lpB ? lpA : lpB;
    if (lpToUser <= 0n) {
      throw new Error("deposit too small: rounds to zero LP");
    }
    circOut = s.circ + lpToUser;
    lockLp = null;
  }

  if (circOut < MIN_LIQ) {
    throw new Error("circulating LP would drop below min_liq");
  }
  if (minLpOut !== undefined && lpToUser < minLpOut) {
    throw new Error(`LP slippage: would receive ${lpToUser} LP, below minimum ${minLpOut}`);
  }

  const heldOut = TOTAL_LP - circOut;
  let poolValue = addReserve(view.value, view.datum.assetA, deltaA);
  poolValue = addReserve(poolValue, view.datum.assetB, deltaB);
  poolValue = setUnit(poolValue, s.lpUnit, heldOut);

  return { firstDeposit: s.firstDeposit, lpToUser, circOut, poolValue, lockLp };
}

/**
 * Build a withdraw: burn `lpToBurn` circulating LP back into the pool and receive a
 * proportional (floored) share of both reserves. `circ_out` must stay `≥ min_liq`.
 * `minAOut`/`minBOut` are optional client-side slippage guards.
 */
export function buildWithdraw(args: {
  view: PoolView;
  lpToBurn: bigint;
  minAOut?: bigint;
  minBOut?: bigint;
}): BuiltWithdraw {
  const { view, lpToBurn, minAOut, minBOut } = args;
  const s = poolStats(view);
  if (lpToBurn <= 0n) throw new Error("withdraw amount must be positive");
  if (s.circ === 0n) throw new Error("pool has no circulating LP to withdraw");
  if (lpToBurn > s.circ) throw new Error("cannot withdraw more LP than circulating");

  const circOut = s.circ - lpToBurn;
  if (circOut < MIN_LIQ) {
    throw new Error(`withdraw would drop circulating LP below min_liq (${MIN_LIQ})`);
  }

  const recvA = (lpToBurn * s.resA) / s.circ; // floor
  const recvB = (lpToBurn * s.resB) / s.circ; // floor
  if (recvA <= 0n && recvB <= 0n) {
    throw new Error("withdraw too small: rounds to zero on both sides");
  }
  if (minAOut !== undefined && recvA < minAOut) {
    throw new Error(`asset A slippage: ${recvA} < minimum ${minAOut}`);
  }
  if (minBOut !== undefined && recvB < minBOut) {
    throw new Error(`asset B slippage: ${recvB} < minimum ${minBOut}`);
  }

  const heldOut = TOTAL_LP - circOut;
  let poolValue = addReserve(view.value, view.datum.assetA, -recvA);
  poolValue = addReserve(poolValue, view.datum.assetB, -recvB);
  poolValue = setUnit(poolValue, s.lpUnit, heldOut);

  return { recvA, recvB, circOut, poolValue };
}

/**
 * Value of an LP balance in reserves (for the "your position" read): a proportional
 * floored share of each reserve. Returns zeros when there is no circulating LP.
 */
export function lpPositionValue(
  stats: PoolStats,
  lpAmount: bigint,
): { a: bigint; b: bigint } {
  if (lpAmount <= 0n || stats.circ <= 0n) return { a: 0n, b: 0n };
  return {
    a: (lpAmount * stats.resA) / stats.circ,
    b: (lpAmount * stats.resB) / stats.circ,
  };
}
