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
 * Transient HTTP/network errors worth retrying (rate-limit, 5xx, dropped conn).
 *
 * MeshJS's BlockfrostProvider throws a JSON STRING (parseHttpError), so the real HTTP
 * status lives inside it — parse it out rather than digit-matching the text (which would
 * over-retry messages that merely contain "503" or "network").
 */
export function isRetriable(e: unknown): boolean {
  const o = e as { status?: unknown; status_code?: unknown; message?: unknown };
  let status = numOr(o?.status) ?? numOr(o?.status_code);
  const text = typeof e === "string" ? e : String(o?.message ?? e ?? "");
  if (status === undefined) {
    try {
      const parsed = JSON.parse(text) as {
        status?: unknown;
        status_code?: unknown;
      };
      status = numOr(parsed?.status) ?? numOr(parsed?.status_code);
    } catch {
      // not JSON — fall through to keyword matching
    }
  }
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  return /\b429\b|rate.?limit|too many requests|timeout|econnreset|etimedout|fetch failed/i.test(
    text,
  );
}
