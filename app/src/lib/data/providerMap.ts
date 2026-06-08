/**
 * Pure value-reading + order→position mapping helpers for the chain-data providers.
 *
 * Split out of `blockfrost.ts` so they can be unit-tested without pulling in the
 * `BlockfrostProvider` SDK or the `@/` path alias (which the Node test runner can't
 * resolve). Only TYPE imports come from `@meshsdk/core` here (they're erased), so the
 * module loads under `node --experimental-strip-types`. Anything provider-specific
 * (HTTP, caching, retries) stays in `blockfrost.ts`; this is the deterministic math/
 * mapping a second provider (Dolos/Koios/…) would reuse verbatim.
 */

import type { Asset, UTxO } from "@meshsdk/core";
import {
  type AssetId,
  assetUnit,
  isAda,
  type LpIntentDatum,
  type OrderDatum,
} from "../chain/datums.ts";
import {
  LP_INTENT_MIN_ADA,
  lpUnitForPool,
  POOL_MIN_ADA,
} from "../chain/deployment.ts";
import type { LpIntentPosition, Pool, TokenInfo, WalletPosition } from "./types.ts";

/** Quantity of `unit` in a Mesh value, as bigint (0 if the unit is absent). */
export function qtyOfUnit(amount: Asset[], unit: string): bigint {
  const found = amount.find((a) => a.unit === unit);
  return found ? BigInt(found.quantity) : 0n;
}

/**
 * Reserve of `asset` in a pool value: its quantity, with `pool_min_ada` carved out when
 * it is the ADA side (BLUEPRINT §5.2.1 / `reserve_of`). Never returns negative — a value
 * carrying less than `pool_min_ada` of ADA floors to 0 rather than underflowing.
 */
export function reserveOf(amount: Asset[], asset: AssetId): bigint {
  const q = qtyOfUnit(amount, assetUnit(asset));
  const r = isAda(asset) ? q - POOL_MIN_ADA : q;
  return r < 0n ? 0n : r;
}

/**
 * Map an order UTXO + decoded datum (+ its pool, if found on-chain) to a UI
 * `WalletPosition`. Bought/sold assets follow from `sell_a` + the pool pair (the datum
 * stores only the pool NFT). If the pool isn't on-chain (an orphan order) the tokens
 * show as placeholders — the order is still owner-reclaimable, which is what matters here.
 */
export function toPosition(
  u: UTxO,
  d: OrderDatum,
  pool: Pool | undefined,
): WalletPosition {
  const unknown: TokenInfo = {
    unit: assetUnit(d.poolNft),
    ticker: "?",
    name: "unknown pool",
    decimals: 0,
  };
  const a = pool?.tokenA ?? unknown;
  const b = pool?.tokenB ?? unknown;
  const tokenIn = d.sellA ? a : b;
  const tokenOut = d.sellA ? b : a;
  return {
    ref: `${u.input.txHash}#${u.input.outputIndex}`,
    tokenIn,
    tokenOut,
    amountIn: d.sellAmount.toString(),
    minOut: d.limit.toString(),
    status: "open",
    partial: d.partial,
    deadline: d.deadline === null ? null : d.deadline.toString(),
  };
}

/**
 * Map an `lp_intent` UTXO + decoded datum (+ its pool, if found on-chain) to a UI
 * `LpIntentPosition`. The locked amounts are read from the UTXO value: a withdraw holds `L`
 * LP tokens; a deposit holds `dA`/`dB`, where the ADA side (if any) is the lovelace minus the
 * tip and the per-UTXO min-ADA (the §5.2.1 triple-role) — disambiguated against the pool pair.
 * An orphan intent (pool not on-chain) shows placeholder tokens; it's still owner-reclaimable.
 */
export function toLpIntentPosition(
  u: UTxO,
  d: LpIntentDatum,
  pool: Pool | undefined,
): LpIntentPosition {
  const poolNftUnit = assetUnit(d.poolNft);
  const unknown: TokenInfo = {
    unit: poolNftUnit,
    ticker: "?",
    name: "unknown pool",
    decimals: 0,
  };
  const tokenA = pool?.tokenA ?? unknown;
  const tokenB = pool?.tokenB ?? unknown;

  const base = {
    ref: `${u.input.txHash}#${u.input.outputIndex}`,
    poolNft: poolNftUnit,
    action: d.action,
    tokenA,
    tokenB,
    minA: d.minA.toString(),
    minB: d.minB.toString(),
    minShares: d.minShares.toString(),
    tip: d.tip.toString(),
    deadline: d.deadline === null ? null : d.deadline.toString(),
  };

  if (d.action === "withdraw") {
    const lp = qtyOfUnit(u.output.amount, lpUnitForPool(poolNftUnit));
    return { ...base, lp: lp.toString() };
  }

  // Deposit: the ADA side carries traded-ADA + tip + min-ADA; carve those out to recover the
  // deposited ADA. A token side reads as its own quantity. (Floors to 0 if a tiny intent has
  // less spare lovelace than tip+min — display-only; the reclaim path uses the raw value.)
  const lovelace = qtyOfUnit(u.output.amount, "lovelace");
  const tradedAda = lovelace - d.tip - LP_INTENT_MIN_ADA;
  const depositedAda = tradedAda < 0n ? 0n : tradedAda;
  const sideAmount = (token: TokenInfo): string =>
    token.unit === "lovelace"
      ? depositedAda.toString()
      : qtyOfUnit(u.output.amount, token.unit).toString();
  return { ...base, depositA: sideAmount(tokenA), depositB: sideAmount(tokenB) };
}
