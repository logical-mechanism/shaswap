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

// Thousands tiers for compact display, largest-first.
const COMPACT_TIERS: ReadonlyArray<readonly [number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * Compact, width-bounded display of a base-unit amount for dense lists (the pools grid):
 * scales by `decimals`, then abbreviates thousands with a single suffix (1.2K / 9M / 412B)
 * so a huge-supply token or a long ticker can't blow the row onto a second line. Below 1000
 * it shows up to 2 trimmed decimals; a non-zero amount under 0.001 reads "<0.001" rather than
 * rounding to "0". Deterministic (no locale) so it matches the app's grouped style and is
 * hydration-stable.
 *
 * Display-only: uses `Number` (not BigInt), so it is NOT exact past 2^53 — fine for a
 * liquidity-proxy glance; full precision lives on the pool's manage page. Falls back to the
 * exact `formatUnits` if the value isn't a finite number.
 */
export function formatCompactUnits(
  amount: string | undefined,
  decimals: number,
): string {
  if (!amount) return "0";
  const n = Number(amount) / 10 ** Math.max(0, decimals);
  if (!Number.isFinite(n)) return formatUnits(amount, decimals);
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs < 0.001) return "<0.001";
  const tier = COMPACT_TIERS.find(([v]) => abs >= v);
  if (!tier) return String(parseFloat(n.toFixed(2)));
  const scaled = n / tier[0];
  const sa = Math.abs(scaled);
  const digits = sa < 10 ? 2 : sa < 100 ? 1 : 0;
  return `${parseFloat(scaled.toFixed(digits))}${tier[1]}`;
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
  // Tolerate grouping/whitespace/underscores (a MAX-populated field carries commas, and
  // users paste grouped amounts) before validating. Strip them, then require the plain
  // numeric shape AND at least one digit (rejects ".").
  const trimmed = input.trim().replace(/[,\s_]/g, "");
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

/**
 * Whether an in-progress amount entry is within a token's decimal precision — used to mask
 * the amount `<input>`s so the user can't type more fractional digits than the token
 * supports (and none at all for a 0-decimal token, which is also our fallback when a
 * token's precision is unknown). Allows a trailing "." and partial entry ("12.", ".5") so
 * typing isn't interrupted, and "" (an empty field). Beyond-precision digits would only be
 * rounded away by `toBaseUnits` anyway — blocking them up front keeps the field honest.
 */
export function withinDecimals(value: string, decimals: number): boolean {
  if (value === "") return true;
  const d = Math.max(0, Math.floor(decimals));
  const mask = d > 0 ? new RegExp(`^\\d*\\.?\\d{0,${d}}$`) : /^\d*$/;
  return mask.test(value);
}

/**
 * A short, cozy relative duration for a future POSIX-ms instant (e.g. an order's settle-by
 * deadline): "~5h", "~3d", "~12m", or "<1m". Returns null once the instant has passed, so the
 * caller can switch to an honest "window closed" note rather than a negative time. Deliberately
 * coarse (one unit, rounded) — it's reassurance, not a countdown. Pure: pass `now` in.
 */
export function relativeFuture(targetMs: number, now: number): string | null {
  if (!Number.isFinite(targetMs)) return null; // a malformed deadline must not render "~NaNd"
  const ms = targetMs - now;
  if (ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `~${mins}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `~${hours}h`;
  const days = Math.round(ms / 86_400_000);
  return `~${days}d`;
}
