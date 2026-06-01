/** Small display formatters (presentation only). */

/** Truncate a bech32 address / long id to `head…tail`. */
export function truncate(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Format a lovelace string/number as ADA with up to 6 decimals. */
export function formatAda(lovelace: string | number | undefined): string {
  if (lovelace === undefined) return "0";
  const n = typeof lovelace === "string" ? Number(lovelace) : lovelace;
  if (!Number.isFinite(n)) return "0";
  return (n / 1_000_000).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

/** Format a base-unit amount given decimals into a human number string. */
export function formatUnits(
  amount: string | undefined,
  decimals: number,
): string {
  if (!amount) return "0";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  return (n / 10 ** decimals).toLocaleString(undefined, {
    maximumFractionDigits: Math.min(decimals, 6),
  });
}

/** Parse a human-typed amount into base units (decimal string) for a token. */
export function toBaseUnits(input: string, decimals: number): string {
  const trimmed = input.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed)) return "";
  const [whole = "0", frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** Format a fraction (0.012) as a percentage string ("1.20%"). */
export function formatPercent(frac: number, digits = 2): string {
  return `${(frac * 100).toFixed(digits)}%`;
}
