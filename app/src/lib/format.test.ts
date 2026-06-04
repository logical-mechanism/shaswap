/**
 * Tests for the BigInt-safe display formatters/parsers (`format.ts`). Run with `npm run test`.
 *
 * These are the highest-trust pure functions in the app — a mis-scaled amount is a wrong
 * order. Covers the half-up rounding, decimals across 0/6/8, exactness beyond
 * Number.MAX_SAFE_INTEGER, and the comma/grouping round-trip that previously dead-ended
 * the MAX/Half button (a grouped "1,000" parsed back to "" and disabled the form).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAda,
  formatCompactUnits,
  formatPercent,
  formatUnits,
  toBaseUnits,
  truncate,
  withinDecimals,
} from "./format.ts";

test("toBaseUnits scales by decimals", () => {
  assert.equal(toBaseUnits("1", 6), "1000000");
  assert.equal(toBaseUnits("1.5", 6), "1500000");
  assert.equal(toBaseUnits("0.000001", 6), "1");
  assert.equal(toBaseUnits("123", 0), "123");
});

test("toBaseUnits rounds half-up at the precision boundary", () => {
  assert.equal(toBaseUnits("1.9", 0), "2"); // 0-decimal token: 1.9 -> 2, not 1
  assert.equal(toBaseUnits("1.4", 0), "1");
  assert.equal(toBaseUnits("0.0000005", 6), "1"); // first dropped digit 5 -> up
  assert.equal(toBaseUnits("0.0000004", 6), "0");
});

test("toBaseUnits rejects malformed input", () => {
  assert.equal(toBaseUnits("", 6), "");
  assert.equal(toBaseUnits(".", 6), "");
  assert.equal(toBaseUnits("abc", 6), "");
  assert.equal(toBaseUnits("1.2.3", 6), "");
});

test("toBaseUnits tolerates grouped / spaced input (MAX-button regression)", () => {
  // formatUnits groups with commas; a comma'd value used to be rejected here, which
  // dead-ended the MAX/Half button. It must now round-trip.
  assert.equal(toBaseUnits("1,000", 0), "1000");
  assert.equal(toBaseUnits("1,234.5", 6), "1234500000");
  assert.equal(toBaseUnits("1_000", 0), "1000");
  assert.equal(toBaseUnits(" 12 ", 0), "12");
});

test("formatCompactUnits abbreviates thousands with a single suffix (bounded width)", () => {
  // Scales by decimals, then K/M/B/T so a huge-supply reserve can't blow out a row.
  assert.equal(formatCompactUnits("1200000000", 0), "1.2B"); // 1.2B TEST
  assert.equal(formatCompactUnits("500000000", 0), "500M"); // 500M HOSKY
  assert.equal(formatCompactUnits("861338911", 6), "861.34"); // ~861 ADA → under 1000, 2dp
  assert.equal(formatCompactUnits("300000000", 6), "300"); // exactly 300 ADA, trimmed
  assert.equal(formatCompactUnits("1003000000", 6), "1K"); // 1003 → 1K (compact glance)
  assert.equal(formatCompactUnits("123456789012", 0), "123B"); // ≥100 → no decimals
});

test("formatCompactUnits handles zero, dust, and empty", () => {
  assert.equal(formatCompactUnits("0", 6), "0");
  assert.equal(formatCompactUnits(undefined, 6), "0");
  assert.equal(formatCompactUnits("1", 6), "<0.001"); // 0.000001 ADA → non-zero dust
});

test("formatUnits groups + trims", () => {
  assert.equal(formatUnits("1000000", 6), "1");
  assert.equal(formatUnits("1234500000", 6), "1,234.5");
  assert.equal(formatUnits("1000", 0), "1,000");
});

test("formatters stay exact beyond Number.MAX_SAFE_INTEGER", () => {
  // 45e15 lovelace (> 2^53), Cardano-max-supply order of magnitude.
  assert.equal(formatAda("45000000000000000"), "45,000,000,000");
  assert.equal(formatUnits("9007199254740993", 0), "9,007,199,254,740,993");
});

test("truncate keeps short strings, shortens long ones", () => {
  assert.equal(truncate("short"), "short");
  assert.match(truncate("a".repeat(40)), /…/);
});

test("formatPercent", () => {
  assert.equal(formatPercent(0.012), "1.20%");
  assert.equal(formatPercent(0.15, 0), "15%");
});

test("withinDecimals masks fractional digits to a token's precision", () => {
  // 6-decimal token (ADA): up to 6 fractional digits, partial entry allowed.
  assert.equal(withinDecimals("", 6), true);
  assert.equal(withinDecimals("12", 6), true);
  assert.equal(withinDecimals("12.", 6), true);
  assert.equal(withinDecimals(".5", 6), true);
  assert.equal(withinDecimals("1.234567", 6), true);
  assert.equal(withinDecimals("1.2345678", 6), false); // 7 > 6
  // 0-decimal / unknown-precision token: no fractional part at all.
  assert.equal(withinDecimals("12", 0), true);
  assert.equal(withinDecimals("12.", 0), false);
  assert.equal(withinDecimals("1.5", 0), false);
  // Garbage / multiple dots rejected regardless of precision.
  assert.equal(withinDecimals("1.2.3", 6), false);
  assert.equal(withinDecimals("abc", 6), false);
});
