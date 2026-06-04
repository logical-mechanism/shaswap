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
  formatPercent,
  formatUnits,
  formatUnitsPlain,
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

test("formatUnits groups + trims; formatUnitsPlain does not group", () => {
  assert.equal(formatUnits("1000000", 6), "1");
  assert.equal(formatUnits("1234500000", 6), "1,234.5");
  assert.equal(formatUnitsPlain("1234500000", 6), "1234.5");
  assert.equal(formatUnits("1000", 0), "1,000");
  assert.equal(formatUnitsPlain("1000", 0), "1000");
});

test("MAX round-trips: formatUnitsPlain output parses back, never over balance", () => {
  // <=6 decimals: exact round-trip (the common case).
  for (const [base, dec] of [
    ["1000", 0],
    ["1003000000", 6],
    ["12345", 0],
  ] as const) {
    const plain = formatUnitsPlain(base, dec);
    assert.ok(!plain.includes(","), `plain has no comma: ${plain}`);
    assert.equal(toBaseUnits(plain, dec), base);
  }
  // High-decimal: display caps at 6 fractional digits, so MAX may leave tiny dust — but
  // must NEVER round up past the real balance.
  const plain8 = formatUnitsPlain("123456789", 8);
  assert.ok(BigInt(toBaseUnits(plain8, 8)) <= 123456789n);
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
