/** Small display formatters (presentation only). */

/** Truncate a bech32 address / long id to `head…tail`. */
export function truncate(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Format a base-unit integer string (e.g. lovelace) into a grouped human number
 * with up to `maxFractionDigits` decimals.
 *
 * Operates on the integer STRING via BigInt-safe string ops — never `Number()` —
 * so it stays exact for values beyond `Number.MAX_SAFE_INTEGER` (Cardano's max
 * supply, 4.5e16 lovelace, is well past 2^53).
 */
function formatBaseUnitString(
  value: string,
  decimals: number,
  maxFractionDigits: number,
): string {
  let s = value.trim();
  if (!s) return "0";

  let sign = "";
  if (s.startsWith("-")) {
    sign = "-";
    s = s.slice(1);
  }
  // Tolerate an unexpected non-integer string by keeping the integer part only.
  if (!/^\d+$/.test(s)) {
    s = s.split(".")[0].replace(/\D/g, "");
    if (!s) return "0";
  }
  s = s.replace(/^0+(?=\d)/, "");

  let whole: string;
  let frac: string;
  if (decimals <= 0) {
    whole = s;
    frac = "";
  } else {
    const padded = s.padStart(decimals + 1, "0");
    whole = padded.slice(0, padded.length - decimals);
    frac = padded.slice(padded.length - decimals);
  }

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const shownFrac = frac
    .slice(0, Math.max(0, maxFractionDigits))
    .replace(/0+$/, "");
  return `${sign}${grouped}${shownFrac ? `.${shownFrac}` : ""}`;
}

/** Format a lovelace string/number as ADA (6 decimals), exact for any size. */
export function formatAda(lovelace: string | number | undefined): string {
  if (lovelace === undefined) return "0";
  const s =
    typeof lovelace === "number" ? Math.trunc(lovelace).toString() : lovelace;
  return formatBaseUnitString(s, 6, 6);
}

/** Format a base-unit amount given decimals into a human number string. */
export function formatUnits(
  amount: string | undefined,
  decimals: number,
): string {
  if (!amount) return "0";
  return formatBaseUnitString(amount, decimals, Math.min(decimals, 6));
}

/**
 * Parse a human-typed amount into base units (decimal string) for a token.
 *
 * Returns "" for malformed input (empty, or a bare "." with no digits) so the
 * UI can treat that as "invalid → disabled". Fractional digits beyond the
 * token's precision are rounded half-up rather than silently truncated — so a
 * 0-decimal token typed as "1.9" becomes "2", not "1".
 */
export function toBaseUnits(input: string, decimals: number): string {
  const trimmed = input.trim();
  // Must match the numeric shape AND contain at least one digit (rejects ".").
  if (!/^\d*\.?\d*$/.test(trimmed) || !/\d/.test(trimmed)) return "";

  const [whole = "", frac = ""] = trimmed.split(".");
  const wholePart = whole === "" ? "0" : whole;
  const dec = Math.max(0, decimals);

  const kept = frac.slice(0, dec).padEnd(dec, "0");
  const nextDigit = frac.charAt(dec); // first dropped fractional digit
  let combined = BigInt(`${wholePart}${kept}` || "0");
  if (nextDigit !== "" && Number(nextDigit) >= 5) combined += 1n;
  return combined.toString();
}

/** Format a fraction (0.012) as a percentage string ("1.20%"). */
export function formatPercent(frac: number, digits = 2): string {
  return `${(frac * 100).toFixed(digits)}%`;
}
