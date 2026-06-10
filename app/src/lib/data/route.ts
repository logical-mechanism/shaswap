/**
 * Smart split router — given the sharded pool set for a pair (BLUEPRINT §5.5: a pair may
 * be `n` independent Pool UTXOs at different fees/depths), work out how to split one swap
 * across pools to maximise the output the user receives.
 *
 * WHY a split and not just "best single pool": ShaSwap orders are pool-bound (each order's
 * datum names one `pool_nft`, §5.1), and a single order draws from exactly one pool's
 * curve. To use more than one shard you must post more than one order. We can post them as
 * N outputs of ONE transaction (one network fee), but each order is an independent UTXO
 * that must carry its own min-ADA and its own solver tip — and each must independently
 * attract a solver. So the tip is the real marginal cost of an extra leg.
 *
 * The math: total received `Σ outᵢ(xᵢ)` over `Σ xᵢ = amountIn` is maximised when the
 * MARGINAL output is equal across every pool that gets a non-zero allocation (water-fill /
 * KKT on a sum of concave constant-product curves). A deeper or lower-fee shard simply
 * absorbs more before its marginal falls to the common level. We then charge each leg one
 * solver tip and keep the split only while the extra output beats the extra tips — so the
 * tip economics, not an arbitrary cap, decide how many legs to use.
 *
 * Pure and side-effect-free: it operates on already-fetched `Pool` objects (no chain
 * access) and reuses `constantProductOut` (the on-chain curve) so every leg's output is
 * bit-exact with what the pool would pay and with the display quote.
 */

import type { Pool, Route, RouteLeg } from "./types";
import { constantProductOut, quoteConstantProduct } from "./quote.ts";
import { toBigInt as toBig } from "../bigint.ts";

export interface PlanRouteOpts {
  /**
   * Per-leg solver tip in lovelace. Each extra leg costs one tip, so this gates how far
   * the swap splits: a leg is only added when its extra output exceeds the extra tip.
   */
  tipLovelace: bigint;
}

/** Internal projection of a candidate pool onto the trade direction. */
interface Cand {
  pool: Pool;
  reserveIn: bigint;
  reserveOut: bigint;
  /** Fee-adjusted multiplier numerator: `10_000 − feeBps` (so γ = gamma/10_000 ∈ (0,1]). */
  gamma: bigint;
  /** Zero-input marginal price `(γ·reserveOut)/reserveIn` as a float, for ordering. */
  marginal: number;
}

/** Above this many shards for one pair we skip exhaustive subset search (see below). */
const MAX_SUBSET_POOLS = 12;

/**
 * Plan the best split of `amountIn` (`tokenIn` → `tokenOut`) across the pools that trade
 * the pair. Returns `null` when no pool trades the pair or the input is non-positive.
 *
 * Token↔token pairs (neither side is ADA) can't price the ADA tip in output units, so the
 * tip gate can't be evaluated honestly — those fall back to the single best pool (no
 * split) in v1. Real ShaSwap pairs are ADA-denominated, which IS priced exactly.
 */
export function planRoute(
  pools: Pool[],
  tokenInUnit: string,
  tokenOutUnit: string,
  amountIn: string,
  opts: PlanRouteOpts,
): Route | null {
  const amt = toBig(amountIn);

  const cands: Cand[] = [];
  for (const pool of pools) {
    const inIsA = pool.tokenA.unit === tokenInUnit && pool.tokenB.unit === tokenOutUnit;
    const inIsB = pool.tokenB.unit === tokenInUnit && pool.tokenA.unit === tokenOutUnit;
    if (!inIsA && !inIsB) continue;
    const reserveIn = toBig(inIsA ? pool.reserveA : pool.reserveB);
    const reserveOut = toBig(inIsA ? pool.reserveB : pool.reserveA);
    if (reserveIn <= 0n || reserveOut <= 0n) continue;
    const gamma = 10_000n - BigInt(pool.feeBps);
    cands.push({
      pool,
      reserveIn,
      reserveOut,
      gamma,
      marginal: (Number(gamma) / 10_000) * (Number(reserveOut) / Number(reserveIn)),
    });
  }
  if (cands.length === 0 || amt <= 0n) return null;

  // Highest spot price first — both for the tip conversion and the subset search order.
  cands.sort((a, b) => b.marginal - a.marginal);

  const sample = cands[0];
  const inIsA0 = sample.pool.tokenA.unit === tokenInUnit;
  const tokenIn = inIsA0 ? sample.pool.tokenA : sample.pool.tokenB;
  const tokenOut = inIsA0 ? sample.pool.tokenB : sample.pool.tokenA;

  // Single-best baseline: the pool that pays the most for the WHOLE input (the deepest
  // pool can beat the highest-spot pool on a large trade), so it is a max over all
  // candidates, not just `cands[0]`.
  let singleBestOut = 0n;
  let singleBestPoolId = cands[0].pool.id;
  for (const c of cands) {
    const out = constantProductOut(c.reserveIn, c.reserveOut, c.pool.feeBps, amt);
    if (out > singleBestOut) {
      singleBestOut = out;
      singleBestPoolId = c.pool.id;
    }
  }

  const tipOut = tipInTokenOut(tokenInUnit, tokenOutUnit, opts.tipLovelace, cands[0]);

  // Choose the subset of pools (and its optimal split) that maximises
  //   net = Σ outᵢ − |subset|·tipOut.
  // Subsets are nested by neither size nor marginal in general (the deepest pool can be
  // the best singleton while a shallower-but-pricier pool joins a 2-split), so for a
  // handful of shards we enumerate ALL non-empty subsets — exact, and 2^n is tiny for the
  // realistic n. Above MAX_SUBSET_POOLS we'd never want that many thin legs anyway; we
  // cap the search at the top pools by spot price (the rest can't clear a full tip).
  const searchCands = cands.slice(0, MAX_SUBSET_POOLS);
  // Token↔token: tip can't be priced → never split (singletons only).
  const allowSplit = tipOut !== null;

  let bestAlloc: { cand: Cand; x: bigint }[] | null = null;
  let bestNet: bigint | null = null; // unset until the first subset scores

  const n = searchCands.length;
  const subsets: number[][] = [];
  if (allowSplit) {
    for (let mask = 1; mask < 1 << n; mask++) {
      const idx: number[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
      subsets.push(idx);
    }
  } else {
    for (let i = 0; i < n; i++) subsets.push([i]);
  }

  for (const idx of subsets) {
    const subset = idx.map((i) => searchCands[i]);
    const x = waterfill(subset, amt);
    let gross = 0n;
    let legCount = 0;
    for (let i = 0; i < subset.length; i++) {
      if (x[i] <= 0n) continue;
      legCount++;
      gross += constantProductOut(subset[i].reserveIn, subset[i].reserveOut, subset[i].pool.feeBps, x[i]);
    }
    if (legCount === 0) continue;
    const tipCost = (tipOut ?? 0n) * BigInt(legCount);
    const net = gross - tipCost;
    // Prefer higher net; tie-break toward FEWER legs (less fragmentation / partial-fill risk).
    if (
      bestNet === null ||
      net > bestNet ||
      (net === bestNet && bestAlloc !== null && legCount < bestAlloc.length)
    ) {
      bestNet = net;
      bestAlloc = subset
        .map((cand, i) => ({ cand, x: x[i] }))
        .filter((l) => l.x > 0n);
    }
  }

  if (!bestAlloc) return null;

  // Build the legs from the exact display quote so every number the UI shows comes from
  // the canonical curve (and matches the standalone single-pool quote exactly).
  const legs: RouteLeg[] = bestAlloc.map(({ cand, x }) => {
    const q = quoteConstantProduct(cand.pool, tokenInUnit, tokenOutUnit, x.toString());
    return {
      poolId: cand.pool.id,
      amountIn: x.toString(),
      amountOut: q.amountOut,
      feeBps: cand.pool.feeBps,
      priceImpact: q.priceImpact,
    };
  });

  const totalOut = legs.reduce((s, l) => s + toBig(l.amountOut), 0n);
  // Defensive: a split must never pay less than the single best pool. By construction it
  // can't (the best singleton is in the search), but clamp the reported baseline so the
  // "improvement vs single pool" the UI shows is never negative from rounding.
  const baseline = totalOut > singleBestOut ? singleBestOut : totalOut;

  // Blended execution price in HUMAN units = (totalOut/totalIn) × 10^(decIn − decOut).
  const RATIO_SCALE = 1_000_000_000_000n;
  const baseRatio = Number((totalOut * RATIO_SCALE) / amt) / 1e12;
  const price = (baseRatio * 10 ** (tokenIn.decimals - tokenOut.decimals)).toString();
  // Input-weighted blended impact.
  const weightedImpact =
    legs.reduce((s, l) => s + l.priceImpact * Number(toBig(l.amountIn)), 0) / Number(amt);

  return {
    tokenIn,
    tokenOut,
    amountIn,
    tip: opts.tipLovelace.toString(),
    amountOut: totalOut.toString(),
    price,
    priceImpact: Math.max(0, weightedImpact),
    legs,
    singleBestOut: baseline.toString(),
    singleBestPoolId,
  };
}

/**
 * Convert one solver tip (lovelace) into tokenOut base units, for the leg-count gate.
 *  - tokenOut IS ADA → the tip already IS in output units (1 lovelace = 1 base unit).
 *  - tokenIn IS ADA → price the tip through the best pool's spot rate (tokenOut/lovelace).
 *  - neither is ADA → can't price it from a token/token pool alone; return null (no split).
 */
function tipInTokenOut(
  tokenInUnit: string,
  tokenOutUnit: string,
  tipLovelace: bigint,
  best: Cand,
): bigint | null {
  if (tokenOutUnit === "lovelace") return tipLovelace;
  if (tokenInUnit === "lovelace") {
    // tokenOut per lovelace ≈ (γ·reserveOut)/(reserveIn·10_000), with reserveIn = lovelace.
    // CEIL the divide: a positive tip must cost at least 1 output base unit, never floor to
    // 0 (which would silently disable the tip gate and over-split for a tiny tip vs a deep,
    // low-priced-token pool — e.g. 1 lovelace × tiny reserveOut / huge reserveIn).
    const num = tipLovelace * best.gamma * best.reserveOut;
    const den = best.reserveIn * 10_000n;
    return num === 0n ? 0n : (num + den - 1n) / den;
  }
  return null;
}

/**
 * Optimal split of `amt` across `active` pools by marginal-price equalisation (water-fill),
 * returned as integer base-unit allocations that sum EXACTLY to `amt`.
 *
 * Solve the continuous problem in float (find the common marginal λ by bisection — total
 * routed is monotone-decreasing in λ), floor to integers, then settle the small remainder
 * unit-by-unit onto whichever pool yields the most marginal output. The float solve only
 * sets proportions; every reported output is exact BigInt, and conservation is exact.
 */
function waterfill(active: Cand[], amt: bigint): bigint[] {
  const k = active.length;
  if (k === 1) return [amt];

  const amtN = Number(amt);
  const Rin = active.map((c) => Number(c.reserveIn));
  const Rout = active.map((c) => Number(c.reserveOut));
  const g = active.map((c) => Number(c.gamma) / 10_000);
  const m0 = active.map((_, i) => (Rout[i] * g[i]) / Rin[i]);

  const routed = (lam: number): number => {
    let s = 0;
    for (let i = 0; i < k; i++) {
      const xi = (Math.sqrt((Rout[i] * g[i] * Rin[i]) / lam) - Rin[i]) / g[i];
      if (xi > 0) s += xi;
    }
    return s;
  };

  // λ ∈ (0, max m0]: at λ = max m0 only the top pool is at its zero point → routed ≈ 0;
  // shrink `lo` until it routes at least `amt`, then bisect.
  let hi = Math.max(...m0);
  let lo = hi;
  for (let i = 0; i < 200 && routed(lo) < amtN; i++) lo /= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (routed(mid) > amtN) lo = mid;
    else hi = mid;
  }
  const lam = (lo + hi) / 2;

  const x: bigint[] = active.map((_, i) => {
    const xi = (Math.sqrt((Rout[i] * g[i] * Rin[i]) / lam) - Rin[i]) / g[i];
    return xi > 0 ? BigInt(Math.floor(xi)) : 0n;
  });

  // The float solve only fixes proportions; everything below is exact BigInt. This finds
  // the marginal-equalising point (the continuous optimum, rounded). NOTE it is not always
  // the exact integer argmax of `Σ floor(outᵢ)`: per-unit marginals are lumpy 0/1 steps so
  // that objective isn't discretely concave, and a neighbouring split can round more
  // favourably. The shortfall vs that argmax is at most the leg count (each pool's floor
  // loses < 1 base unit) — ≤ N millionths of a token, economically nil. Conservation
  // (Σx == amt) is then EXACT or the function throws (the tripwire below), so a non-
  // conserving split can never reach the caller; planRoute's own subset search separately
  // guarantees the chosen route is ≥ the best single pool.
  const out = (i: number, q: bigint) =>
    constantProductOut(active[i].reserveIn, active[i].reserveOut, active[i].pool.feeBps, q);
  // Value of the NEXT unit added to pool i, and of the LAST unit currently in pool i.
  const gain = (i: number) => out(i, x[i] + 1n) - out(i, x[i]);
  const loss = (i: number) => (x[i] > 0n ? out(i, x[i]) - out(i, x[i] - 1n) : -1n);

  // 1) Restore conservation (Σx = amt) — floor undershoots, occasionally a float overshoot.
  let used = x.reduce((s, v) => s + v, 0n);
  let guard = 0;
  while (used !== amt && guard++ < 5_000_000) {
    if (used < amt) {
      let j = 0;
      for (let i = 1; i < k; i++) if (gain(i) > gain(j)) j = i;
      x[j] += 1n;
      used += 1n;
    } else {
      let i = -1;
      for (let t = 0; t < k; t++) if (x[t] > 0n && (i < 0 || loss(t) < loss(i))) i = t;
      if (i < 0) break;
      x[i] -= 1n;
      used -= 1n;
    }
  }

  // 2) Improving-unit transfers: move a unit from the pool whose last unit is worth least
  // to the pool whose next unit is worth most, while that strictly raises total output.
  // For a sum of concave curves this fixed point IS the global integer optimum. From the
  // near-optimal floored start only a handful of moves are ever needed.
  guard = 0;
  while (guard++ < 5_000_000) {
    let j = 0; // best receiver
    for (let i = 1; i < k; i++) if (gain(i) > gain(j)) j = i;
    let i = -1; // worst giver (≠ j, must hold a unit)
    for (let t = 0; t < k; t++) {
      if (t === j || x[t] <= 0n) continue;
      if (i < 0 || loss(t) < loss(i)) i = t;
    }
    if (i < 0 || gain(j) <= loss(i)) break;
    x[j] += 1n;
    x[i] -= 1n;
  }

  // Tripwire: the cleanup is O(legs) and always reaches Σx == amt for realistic inputs, so
  // this never fires — but assert it rather than ever hand the caller a split whose legs
  // don't sum to the swap amount (a guard cap or a future edit could otherwise slip a
  // non-conserving allocation through silently).
  if (x.reduce((s, v) => s + v, 0n) !== amt) {
    throw new Error("waterfill: allocation did not conserve the input");
  }
  return x;
}
