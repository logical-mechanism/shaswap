/**
 * Parse a decimal-or-integer string to `bigint`, keeping only the integer part, and
 * returning `0n` on empty/garbage input. This is the safe, shared version of the little
 * `toBig` helper that had been copy-pasted into five files (SwapCard, LiquidityPanel,
 * pools page, quote, blockfrost) — some splitting on "." and some not. Splitting is the
 * superset: integer strings are unaffected, and a stray decimal can't throw.
 */
export function toBigInt(s: string | undefined | null): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s.split(".")[0] || "0");
  } catch {
    return 0n;
  }
}
