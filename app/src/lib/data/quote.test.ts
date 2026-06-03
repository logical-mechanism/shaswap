/**
 * Tests for the constant-product DISPLAY quote (`quote.ts`). It drives the rate line and
 * the floor (minimum received), so its math must be exact and its displayed price must be
 * in HUMAN units. Run with `npm run test`.
 *
 * The decimals case is a regression for the bug where `price` was a raw base-unit ratio
 * (reserveOut/reserveIn) and so disagreed with the displayed "To" amount by
 * 10^(decIn − decOut) whenever the two tokens had different decimals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteConstantProduct } from "./quote.ts";
import type { Pool, TokenInfo } from "./types.ts";

const ADA: TokenInfo = { unit: "lovelace", ticker: "ADA", name: "Cardano", decimals: 6 };
const TOK0: TokenInfo = { unit: "aa", ticker: "TOK", name: "Token", decimals: 0 };
const TOK0B: TokenInfo = { unit: "bb", ticker: "TKB", name: "TokenB", decimals: 0 };
const SIX: TokenInfo = { unit: "cc", ticker: "SIX", name: "Six", decimals: 6 };

/** A token/token pool with clean small reserves for exact amountOut checks. */
function mathPool(feeBps: number): Pool {
  return {
    id: "math",
    tokenA: TOK0,
    tokenB: TOK0B,
    reserveA: "1000",
    reserveB: "1000",
    feeBps,
  };
}

test("amountOut: x*y=k with no fee is exact", () => {
  const q = quoteConstantProduct(mathPool(0), TOK0.unit, TOK0B.unit, "1000");
  // out = 1000*1000 / (1000+1000) = 500
  assert.equal(q.amountOut, "500");
  assert.equal(q.price, "1"); // same decimals -> mid ratio 1000/1000
  assert.ok(Math.abs(q.priceImpact - 0.5) < 1e-9); // exec 0.5 vs mid 1.0
});

test("fee reduces output (fee boundary)", () => {
  const out0 = quoteConstantProduct(mathPool(0), TOK0.unit, TOK0B.unit, "1000").amountOut;
  const out30 = quoteConstantProduct(mathPool(30), TOK0.unit, TOK0B.unit, "1000").amountOut;
  // inAfterFee = 997 -> out = 1000*997/(1000+997) = floor(996503/1997)... = 499
  assert.equal(out30, "499");
  assert.ok(BigInt(out30) < BigInt(out0));
});

test("displayed price is decimal-adjusted (regression for the rate-line bug)", () => {
  // ADA(6) / TOK(0) pool: base-unit reserve ratio is 2.0, but the HUMAN rate is
  // 2.0 * 10^(6-0) = 2,000,000 TOK per ADA.
  const pool: Pool = {
    id: "p",
    tokenA: ADA,
    tokenB: TOK0,
    reserveA: "1000000000", // 1000 ADA
    reserveB: "2000000000", // 2,000,000,000 TOK (0 decimals)
    feeBps: 30,
  };
  const q = quoteConstantProduct(pool, ADA.unit, TOK0.unit, "100000000"); // 100 ADA in
  assert.equal(q.price, "2000000");
  // The output is in TOK base units and must be on the same (millions) scale as the
  // price — i.e. the rate line and the "To" amount agree, not off by 10^6.
  assert.ok(BigInt(q.amountOut) > 100_000_000n);
});

test("tiny human price (sell low-decimal token for ADA) does NOT floor to 0", () => {
  // TOK(0 decimals) → ADA(6): 1 TOK is worth ~5e-7 ADA. The displayed price must stay
  // positive (a BigInt floor-divide would round it to "0" and suppress the rate line).
  const pool: Pool = {
    id: "p3",
    tokenA: ADA,
    tokenB: TOK0,
    reserveA: "1000000000", // 1000 ADA
    reserveB: "2000000000", // 2,000,000,000 TOK
    feeBps: 30,
  };
  const q = quoteConstantProduct(pool, TOK0.unit, ADA.unit, "1000000"); // sell 1,000,000 TOK
  assert.ok(BigInt(q.amountOut) > 0n, "amountOut should be a valid non-zero swap");
  assert.ok(Number(q.price) > 0, `price should be > 0, got ${q.price}`);
});

test("price unaffected when both tokens share decimals", () => {
  const pool: Pool = {
    id: "p2",
    tokenA: ADA,
    tokenB: SIX,
    reserveA: "1000000000",
    reserveB: "3000000000",
    feeBps: 30,
  };
  const q = quoteConstantProduct(pool, ADA.unit, SIX.unit, "1000000");
  assert.equal(q.price, "3"); // 3,000,000,000 / 1,000,000,000, same decimals
});

test("zero / empty amount and empty reserves are guarded", () => {
  const zeroAmt = quoteConstantProduct(mathPool(30), TOK0.unit, TOK0B.unit, "0");
  assert.equal(zeroAmt.amountOut, "0");
  assert.equal(zeroAmt.price, "0");
  assert.equal(zeroAmt.priceImpact, 0);

  const emptyPool: Pool = {
    id: "e",
    tokenA: TOK0,
    tokenB: TOK0B,
    reserveA: "0",
    reserveB: "0",
    feeBps: 30,
  };
  const q = quoteConstantProduct(emptyPool, TOK0.unit, TOK0B.unit, "100");
  assert.equal(q.amountOut, "0");
  assert.equal(q.poolId, "e");
});
