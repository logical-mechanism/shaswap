/**
 * Pure provider helpers — no SDK/network imports, so they're unit-testable in isolation
 * (the rest of `blockfrost.ts` pulls in `@meshsdk/core` + the `@/` alias, which the Node
 * test runner can't load). Keep anything here free of external dependencies.
 */

function numOr(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Static fee `fee_num/fee_den` → integer basis points (3/1000 → 30). */
export function feeToBps(feeNum: bigint, feeDen: bigint): number {
  if (feeDen <= 0n) return 0;
  return Number((feeNum * 10_000n) / feeDen);
}

/**
 * The HTTP status carried by a provider error, if any.
 *
 * MeshJS's BlockfrostProvider throws a JSON STRING (parseHttpError), so the real HTTP
 * status lives inside it — look on the object first (`status` / `status_code`), then parse
 * a JSON-string message. Returns undefined for a plain network blip with no status (the
 * caller decides what to do — retry by keyword, or treat as "unknown, not a clean 404").
 */
export function httpStatus(e: unknown): number | undefined {
  const o = e as { status?: unknown; status_code?: unknown; message?: unknown };
  const direct = numOr(o?.status) ?? numOr(o?.status_code);
  if (direct !== undefined) return direct;
  const text = typeof e === "string" ? e : String(o?.message ?? e ?? "");
  try {
    const parsed = JSON.parse(text) as {
      status?: unknown;
      status_code?: unknown;
    };
    return numOr(parsed?.status) ?? numOr(parsed?.status_code);
  } catch {
    return undefined; // not JSON — no status available
  }
}

/**
 * Transient HTTP/network errors worth retrying (rate-limit, 5xx, dropped conn).
 *
 * Uses the parsed HTTP status (see `httpStatus`) rather than digit-matching the text
 * (which would over-retry messages that merely contain "503" or "network"), falling back
 * to keyword matching for statusless network blips.
 */
export function isRetriable(e: unknown): boolean {
  const o = e as { message?: unknown };
  const text = typeof e === "string" ? e : String(o?.message ?? e ?? "");
  const status = httpStatus(e);
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  return /\b429\b|rate.?limit|too many requests|timeout|econnreset|etimedout|fetch failed/i.test(
    text,
  );
}
