/**
 * Shared fixtures for the Vitest component/hook suite. Plain data (no vi.mock here, so it
 * can be imported normally). Lives under src/test/** — excluded from the lint/type gates,
 * exercised by `npm run test:components`.
 */

import type { Pool, Quote, TokenInfo } from "@/lib/data";
import type { PoolDatum } from "@/lib/chain/datums";
import type { PoolView } from "@/lib/chain/lp";
import {
  lpUnitForPool,
  POOL_MIN_ADA,
  TOTAL_LP,
} from "@/lib/chain/deployment";

export const ADA: TokenInfo = {
  unit: "lovelace",
  ticker: "ADA",
  name: "Cardano",
  decimals: 6,
};

const TEST_POLICY = "8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a";
export const TEST: TokenInfo = {
  unit: TEST_POLICY + "54455354",
  ticker: "TEST",
  name: "ShaSwap Test Token",
  decimals: 0,
};

const NFT_POLICY = "1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d0";
export const POOL_NFT_UNIT = NFT_POLICY + "4e4654";
export const POOL_LP_UNIT = lpUnitForPool(POOL_NFT_UNIT);

export const TOKENS: TokenInfo[] = [ADA, TEST];

/** A seeded ADA/TEST pool (asset_a = ADA, asset_b = TEST). */
export const POOL: Pool = {
  id: POOL_NFT_UNIT,
  tokenA: ADA,
  tokenB: TEST,
  reserveA: "1000000000", // 1000 ADA
  reserveB: "2000000000",
  feeBps: 30,
  firstDeposit: false,
};

export const POOLS: Pool[] = [POOL];

/** A constant-product-ish quote for ADA→TEST (display estimate only). */
export function quoteFor(amountIn: string, poolId = POOL_NFT_UNIT): Quote {
  return {
    tokenIn: ADA,
    tokenOut: TEST,
    amountIn,
    amountOut: "1900000000",
    price: "1.9",
    priceImpact: 0.01,
    poolId,
  };
}

/** Owner pkh used for the pool creator in the view datum. */
export const CREATOR_PKH = "ab".repeat(28);

export const POOL_DATUM: PoolDatum = {
  nft: { policy: NFT_POLICY, name: "4e4654" },
  assetA: { policy: "", name: "" }, // ADA
  assetB: { policy: TEST_POLICY, name: "54455354" },
  feeNum: 3n,
  feeDen: 1000n,
  creator: { kind: "key", hash: CREATOR_PKH },
};

/**
 * Build a resolved pool UTXO view with a given circulating-LP supply. resA/resB are the
 * intended reserves; the ADA side carries the `pool_min_ada` overhead, the LP side the
 * held = total_lp − circ balance, plus the single NFT.
 */
export function poolViewWithCirc(
  circ: bigint,
  resA = 1_000_000_000n,
  resB = 2_000_000_000n,
): PoolView {
  const held = TOTAL_LP - circ;
  return {
    datum: POOL_DATUM,
    value: [
      { unit: "lovelace", quantity: (resA + POOL_MIN_ADA).toString() },
      { unit: TEST.unit, quantity: resB.toString() },
      { unit: POOL_NFT_UNIT, quantity: "1" },
      { unit: POOL_LP_UNIT, quantity: held.toString() },
    ],
  };
}
