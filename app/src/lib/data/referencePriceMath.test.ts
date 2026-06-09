import { test } from "node:test";
import assert from "node:assert/strict";
import { composePricePerA, humanAdaPerToken } from "./referencePriceMath.ts";

test("humanAdaPerToken adjusts MuesliSwap's raw price by the decimal gap", () => {
  // MIN: base 6 (ADA), quote 6 → unchanged (raw == human).
  assert.equal(humanAdaPerToken(0.0192, 6, 6), 0.0192);
  // HOSKY: base 6 (ADA), quote 0 → ×10^-6 (raw 0.0452 lovelace/HOSKY ⇒ ~4.5e-8 ADA).
  assert.ok(Math.abs(humanAdaPerToken(0.0452, 6, 0) - 0.0452e-6) < 1e-18);
  // A higher-precision quote (8 decimals) scales the other way.
  assert.ok(Math.abs(humanAdaPerToken(1, 6, 8) - 100) < 1e-9);
});

test("composePricePerA = adaPerA / adaPerB", () => {
  // 1 tokenA worth 2 ADA, 1 tokenB worth 0.5 ADA → 1 A ≈ 4 B.
  assert.equal(composePricePerA(2, 0.5), 4);
  // ADA on one side (price 1) round-trips: token worth 0.02 ADA → 1 ADA ≈ 50 token.
  assert.equal(composePricePerA(1, 0.02), 50);
});

test("composePricePerA rejects non-positive inputs (no NaN/Infinity leaks)", () => {
  assert.equal(composePricePerA(0, 1), null);
  assert.equal(composePricePerA(1, 0), null);
  assert.equal(composePricePerA(-1, 1), null);
  assert.equal(composePricePerA(Number.NaN, 1), null);
});
