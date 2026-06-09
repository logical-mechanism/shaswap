/**
 * Pure price math for the external market reference — split out (no app/config/network deps)
 * so it is unit-testable under the node `--test` strip-types runner, mirroring orderFunding.
 * See `referencePrice.ts` for the (server-only, network-bound) source that uses these.
 */

/**
 * Human ADA per 1 human token from MuesliSwap's raw `price` (base = ADA, quote = token).
 * `price` is base-base-units per quote-base-unit, so adjust by the decimal gap.
 */
export function humanAdaPerToken(
  price: number,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  return price * 10 ** (quoteDecimals - baseDecimals);
}

/**
 * Compose "human tokenB per 1 human tokenA" from each token's human ADA price; null on a
 * non-positive input (so a missing/zero price never yields Infinity/NaN).
 */
export function composePricePerA(
  adaPerA: number,
  adaPerB: number,
): number | null {
  if (!(adaPerA > 0) || !(adaPerB > 0)) return null;
  return adaPerA / adaPerB;
}
