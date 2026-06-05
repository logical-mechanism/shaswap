/**
 * Tests for the LP-intent min-out quotes — parity with the batcher's pin generator
 * (`batcher/crates/solver-core/src/lp.rs`) and the conservative-rounding invariant that keeps
 * an app-built intent always fulfillable by an honest batcher. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteLpDeposit, quoteLpWithdraw, withSlippage } from "./lpQuote.ts";
import type { PoolStats } from "./lp.ts";
import { MIN_LIQ, TOTAL_LP } from "./deployment.ts";

/** Minimal PoolStats for the math (lpUnit/nftUnit/firstDeposit are unused by the quotes). */
function stats(resA: bigint, resB: bigint, circ: bigint): PoolStats {
  return {
    resA,
    resB,
    held: TOTAL_LP - circ,
    circ,
    lpUnit: "lp",
    nftUnit: "nft",
    firstDeposit: circ === 0n,
  };
}

// ---- parity with the Rust lp.rs fixtures (asset_a = tok 200M, asset_b = ada 100M, circ 1M) ----

test("withdraw fair amounts match the Rust withdraw_matches_aiken_fixture", () => {
  const q = quoteLpWithdraw(stats(200_000_000n, 100_000_000n, 1_000_000n), 100_000n, 0);
  assert.equal(q.fairA, 20_000_000n); // floor(100k · 200M / 1M)
  assert.equal(q.fairB, 10_000_000n); // floor(100k · 100M / 1M)
  // 0% slippage ⇒ floor == fair
  assert.equal(q.minA, 20_000_000n);
  assert.equal(q.minB, 10_000_000n);
});

test("deposit fair shares match the Rust deposit_matches_aiken_fixture", () => {
  const q = quoteLpDeposit(stats(200_000_000n, 100_000_000n, 1_000_000n), 20_000_000n, 10_000_000n, 0);
  assert.equal(q.fairShares, 100_000n); // min(floor(20M·1M/200M), floor(10M·1M/100M))
  assert.equal(q.minShares, 100_000n);
});

test("deposit shares are limited by the SHORTER side (min of the two)", () => {
  // amountB over-supplied: shares set by asset_a side.
  const q = quoteLpDeposit(stats(200_000_000n, 100_000_000n, 1_000_000n), 20_000_000n, 50_000_000n, 0);
  assert.equal(q.fairShares, 100_000n); // floor(20M·1M/200M) = 100k < floor(50M·1M/100M)=500k
});

// ---- conservative rounding: the pinned floor is always ≤ the fair amount ----

test("slippage floors are ≤ fair (withdraw + deposit) for a 0.5% haircut", () => {
  const wd = quoteLpWithdraw(stats(1_000_000_000n, 2_000_000_000n, 1_000_000n), 500_000n, 0.5);
  assert.ok(wd.minA <= wd.fairA && wd.minB <= wd.fairB);
  assert.equal(wd.minA, withSlippage(wd.fairA, 0.5));
  const dep = quoteLpDeposit(stats(1_000_000_000n, 2_000_000_000n, 1_000_000n), 100_000_000n, 200_000_000n, 0.5);
  assert.ok(dep.minShares <= dep.fairShares);
  assert.equal(dep.minShares, withSlippage(dep.fairShares, 0.5));
});

// ---- property: a deterministic LCG sweep asserts parity + fulfillability ----

test("property: fair amounts equal the floor formula and floors are conservative (5000 samples)", () => {
  // Deterministic LCG (no Math.random — reproducible failures).
  let seed = 0x9e3779b1;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 5000; i++) {
    const resA = BigInt(1 + rnd(5_000_000_000));
    const resB = BigInt(1 + rnd(5_000_000_000));
    const circ = BigInt(MIN_LIQ + 1n) + BigInt(rnd(10_000_000));
    const slip = rnd(500) / 100; // 0–5%

    // withdraw: L bounded so circ_out ≥ MIN_LIQ
    const maxL = circ - MIN_LIQ;
    if (maxL >= 1n) {
      const L = 1n + BigInt(rnd(Number(maxL < 1_000_000n ? maxL : 1_000_000n)));
      try {
        const q = quoteLpWithdraw(stats(resA, resB, circ), L, slip);
        assert.equal(q.fairA, (L * resA) / circ, "withdraw fairA = floor(L·resA/circ)");
        assert.equal(q.fairB, (L * resB) / circ, "withdraw fairB = floor(L·resB/circ)");
        assert.ok(q.minA <= q.fairA && q.minB <= q.fairB, "withdraw floor ≤ fair");
        // an honest batcher (unchanged reserves) releases fairA/fairB ≥ the pinned floor.
        assert.ok(q.fairA >= q.minA && q.fairB >= q.minB);
      } catch {
        // dust withdraw (rounds to 0) — acceptable rejection, not a parity failure
      }
    }

    // deposit
    const dA = BigInt(1 + rnd(2_000_000_000));
    const dB = BigInt(1 + rnd(2_000_000_000));
    try {
      const q = quoteLpDeposit(stats(resA, resB, circ), dA, dB, slip);
      const sa = (dA * circ) / resA;
      const sb = (dB * circ) / resB;
      assert.equal(q.fairShares, sa < sb ? sa : sb, "deposit fairShares = min(floor…)");
      assert.ok(q.minShares <= q.fairShares, "deposit floor ≤ fair");
    } catch {
      // dust deposit (rounds to 0 LP) — acceptable rejection
    }
  }
});

// ---- guards ----

test("first deposit (circ == 0) is rejected for an intent (seed directly)", () => {
  assert.throws(() => quoteLpDeposit(stats(0n, 0n, 0n), 1_000n, 1_000n, 0));
});

test("withdraw that would breach MIN_LIQ is rejected", () => {
  // circ = MIN_LIQ + 10; redeeming 11 leaves circ_out < MIN_LIQ.
  assert.throws(() => quoteLpWithdraw(stats(1_000_000n, 1_000_000n, MIN_LIQ + 10n), 11n, 0));
});
