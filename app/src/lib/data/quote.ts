import type { Pool, Quote } from "./types";

/**
 * Constant-product (x·y=k) quote with fee for ONE pool — a DISPLAY estimate over the
 * pool's real reserves, shared by every provider so the math can't drift between them.
 *
 * This is NOT ShaSwap's batch-auction clearing: the user posts an intent and an
 * untrusted solver settles it at a uniform price, never below the per-order floor.
 */
export function quoteConstantProduct(
  pool: Pool,
  tokenInUnit: string,
  tokenOutUnit: string,
  amountIn: string,
): Quote {
  const tokenIn = pool.tokenA.unit === tokenInUnit ? pool.tokenA : pool.tokenB;
  const tokenOut = pool.tokenA.unit === tokenOutUnit ? pool.tokenA : pool.tokenB;
  const amtIn = toBig(amountIn);
  const inIsA = pool.tokenA.unit === tokenInUnit;
  const reserveIn = toBig(inIsA ? pool.reserveA : pool.reserveB);
  const reserveOut = toBig(inIsA ? pool.reserveB : pool.reserveA);

  if (amtIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: "0",
      price: "0",
      priceImpact: 0,
      poolId: pool.id,
    };
  }

  const feeBps = BigInt(pool.feeBps);
  const inAfterFee = (amtIn * (10_000n - feeBps)) / 10_000n;
  const amountOut = (reserveOut * inAfterFee) / (reserveIn + inAfterFee);

  const SCALE = 1_000_000n;
  // Price impact is computed on the raw BASE-unit ratios; it's dimensionless, so token
  // decimals cancel and it needs no adjustment.
  const midScaled = (reserveOut * SCALE) / reserveIn;
  const execScaled = (amountOut * SCALE) / amtIn;
  const priceImpact =
    midScaled > 0n
      ? Math.max(0, Number(midScaled - execScaled) / Number(midScaled))
      : 0;

  // DISPLAY price = tokenOut per tokenIn in HUMAN units. The base-unit ratio
  // reserveOut/reserveIn only equals the human ratio when both tokens share decimals;
  // otherwise it's off by 10^(decIn − decOut). Fold that factor into the BigInt scaling
  // (so precision is kept) before the single final Number() divide for display.
  const dDiff = tokenIn.decimals - tokenOut.decimals;
  const pow = (n: number): bigint => 10n ** BigInt(Math.abs(n));
  const priceNumer = dDiff >= 0 ? reserveOut * SCALE * pow(dDiff) : reserveOut * SCALE;
  const priceDenom = dDiff >= 0 ? reserveIn : reserveIn * pow(-dDiff);
  const priceScaled = priceNumer / priceDenom; // = display price × SCALE

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut: amountOut.toString(),
    price: (Number(priceScaled) / Number(SCALE)).toString(),
    priceImpact,
    poolId: pool.id,
  };
}

function toBig(s: string): bigint {
  try {
    return BigInt(s.split(".")[0] || "0");
  } catch {
    return 0n;
  }
}
