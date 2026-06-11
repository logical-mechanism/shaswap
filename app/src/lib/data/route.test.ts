/**
 * Tests for the smart split router (`route.ts`). The router decides how to split one swap
 * across the sharded pools for a pair to maximise output, charging one solver tip per leg.
 *
 * The load-bearing properties, asserted below:
 *  - CONSERVATION: the legs' inputs sum EXACTLY to the swap amount (no lost/created units).
 *  - NEVER WORSE: the chosen route's total output is ≥ the best single pool — a split is
 *    only taken when it strictly beats not-splitting net of the extra tips.
 *  - OPTIMALITY: with the tip set to 0 the gross output matches a brute-force integer
 *    search over all splits (the water-fill + integer-cleanup really finds the optimum).
 *  - TIP GATE: a split is dropped when its extra output no longer covers the extra tip.
 *
 * Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planRoute } from "./route.ts";
import { quoteConstantProduct } from "./quote.ts";
import type { Pool, TokenInfo } from "./types.ts";

const ADA: TokenInfo = { unit: "lovelace", ticker: "ADA", name: "Cardano", decimals: 6 };
const TOK: TokenInfo = { unit: "aa", ticker: "TOK", name: "Token", decimals: 0 };
const TKB: TokenInfo = { unit: "bb", ticker: "TKB", name: "TokenB", decimals: 0 };

/** A TOK/ADA pool (tokenA = TOK, tokenB = ADA) with the given reserves + fee. */
function tokAdaPool(id: string, resTok: string, resAda: string, feeBps: number): Pool {
  return { id, tokenA: TOK, tokenB: ADA, reserveA: resTok, reserveB: resAda, feeBps };
}

/** Sum a route's leg inputs as a BigInt. */
function sumIn(legs: { amountIn: string }[]): bigint {
  return legs.reduce((s, l) => s + BigInt(l.amountIn), 0n);
}

/** Brute-force the best integer split of `amt` across exactly two pools (sell TOK→ADA). */
function bruteBestTwo(pools: Pool[], amt: bigint): bigint {
  let best = 0n;
  for (let a = 0n; a <= amt; a++) {
    const o0 = BigInt(quoteConstantProduct(pools[0], TOK.unit, ADA.unit, a.toString()).amountOut);
    const o1 = BigInt(
      quoteConstantProduct(pools[1], TOK.unit, ADA.unit, (amt - a).toString()).amountOut,
    );
    if (o0 + o1 > best) best = o0 + o1;
  }
  return best;
}

/** The best output from a SINGLE pool, computed INDEPENDENTLY of the router (so the
 * never-worse check can't be fooled by the router's own clamped baseline). */
function bestSinglePool(pools: Pool[], inUnit: string, outUnit: string, amt: bigint): bigint {
  let best = 0n;
  for (const p of pools) {
    const o = BigInt(quoteConstantProduct(p, inUnit, outUnit, amt.toString()).amountOut);
    if (o > best) best = o;
  }
  return best;
}

/** Brute-force the best integer split of `amt` across ANY number of pools (sell `inUnit`
 * → `outUnit`): the true max of `Σ floor(outᵢ)` over every composition. Exponential —
 * use only with few pools and small amounts. */
function bruteBestN(pools: Pool[], inUnit: string, outUnit: string, amt: bigint): bigint {
  const out = (i: number, x: bigint) =>
    BigInt(quoteConstantProduct(pools[i], inUnit, outUnit, x.toString()).amountOut);
  const rec = (i: number, remaining: bigint): bigint => {
    if (i === pools.length - 1) return out(i, remaining);
    let best = 0n;
    for (let a = 0n; a <= remaining; a++) {
      const v = out(i, a) + rec(i + 1, remaining - a);
      if (v > best) best = v;
    }
    return best;
  };
  return rec(0, amt);
}

/** Brute-force the best NET output of splitting `amt` across pools, where each non-empty
 * leg costs one `tip` (in tokenOut units): `max over compositions of Σ floor(outᵢ) −
 * (#non-zero legs)·tip`. This is the router's actual objective, so it checks the LEG-COUNT
 * choice (how far to split), not just the split given a fixed set. Exponential — small only. */
function bruteBestNetN(
  pools: Pool[],
  inUnit: string,
  outUnit: string,
  amt: bigint,
  tip: bigint,
): bigint {
  const out = (i: number, x: bigint) =>
    BigInt(quoteConstantProduct(pools[i], inUnit, outUnit, x.toString()).amountOut);
  const rec = (i: number, remaining: bigint): bigint => {
    if (i === pools.length - 1) return remaining > 0n ? out(i, remaining) - tip : 0n;
    let best = remaining > 0n ? out(i, remaining) - tip : 0n; // all-remaining-here seed
    for (let a = 0n; a <= remaining; a++) {
      const here = a > 0n ? out(i, a) - tip : 0n;
      const v = here + rec(i + 1, remaining - a);
      if (v > best) best = v;
    }
    return best;
  };
  return rec(0, amt);
}

/** A tiny deterministic PRNG (mulberry32) so a fuzz failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (r: () => number, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));

test("no pool for the pair → null", () => {
  const pools = [tokAdaPool("p", "1000", "1000", 30)];
  assert.equal(planRoute(pools, "aa", "zz", "100", { tipLovelace: 0n }), null);
});

test("zero amount → null", () => {
  const pools = [tokAdaPool("p", "1000", "1000", 30)];
  assert.equal(planRoute(pools, "aa", "lovelace", "0", { tipLovelace: 0n }), null);
});

test("single pool → one leg, equals the standalone single-pool quote", () => {
  const pools = [tokAdaPool("p", "1000", "1000", 30)];
  const r = planRoute(pools, "aa", "lovelace", "100", { tipLovelace: 0n });
  assert.ok(r);
  assert.equal(r.legs.length, 1);
  const q = quoteConstantProduct(pools[0], "aa", "lovelace", "100");
  assert.equal(r.amountOut, q.amountOut);
  assert.equal(r.amountOut, r.singleBestOut);
  assert.equal(sumIn(r.legs), 100n);
});

test("two equal pools, big trade → splits ~50/50 and beats one pool", () => {
  const pools = [
    tokAdaPool("p0", "1000", "1000", 0),
    tokAdaPool("p1", "1000", "1000", 0),
  ];
  const r = planRoute(pools, "aa", "lovelace", "100", { tipLovelace: 0n });
  assert.ok(r);
  assert.equal(r.legs.length, 2);
  // 50/50 split: each pays floor(1000*50/1050)=47 → 94, vs single floor(1000*100/1100)=90.
  assert.equal(r.amountOut, "94");
  assert.equal(r.singleBestOut, "90");
  assert.ok(BigInt(r.amountOut) > BigInt(r.singleBestOut));
  assert.equal(sumIn(r.legs), 100n);
});

test("CONSERVATION: legs always sum to the input (asymmetric depths/fees)", () => {
  const pools = [
    tokAdaPool("p0", "1234", "5678", 30),
    tokAdaPool("p1", "98765", "43210", 5),
    tokAdaPool("p2", "5000", "5000", 100),
  ];
  for (const amt of ["1", "777", "13579", "250000"]) {
    const r = planRoute(pools, "aa", "lovelace", amt, { tipLovelace: 0n });
    assert.ok(r, `route for ${amt}`);
    assert.equal(sumIn(r.legs).toString(), amt, `conservation for ${amt}`);
    // No dust legs (every leg carries a positive input).
    for (const l of r.legs) assert.ok(BigInt(l.amountIn) > 0n);
  }
});

test("NEVER WORSE: total output ≥ an INDEPENDENT best single pool, always", () => {
  const pools = [
    tokAdaPool("p0", "1000", "2000", 30),
    tokAdaPool("p1", "50000", "60000", 10),
    tokAdaPool("p2", "3000", "2500", 50),
  ];
  for (const amt of ["10", "500", "9999", "120000"]) {
    const r = planRoute(pools, "aa", "lovelace", amt, { tipLovelace: 0n });
    assert.ok(r);
    // Compare against a baseline computed OUTSIDE the router — not r.singleBestOut, which
    // the router clamps to min(trueBest, total) and so would hide a worse-than-one-pool bug.
    const indepBest = bestSinglePool(pools, "aa", "lovelace", BigInt(amt));
    assert.ok(
      BigInt(r.amountOut) >= indepBest,
      `total ${r.amountOut} ≥ independent single best ${indepBest} for ${amt}`,
    );
    // And the route's REPORTED baseline must equal the true best (never-worse ⇒ no clamp).
    assert.equal(r.singleBestOut, indepBest.toString(), `reported baseline for ${amt}`);
  }
});

test("OPTIMALITY: tip=0 gross output is within the floor-slack bound of brute force", () => {
  // The router targets the continuous (marginal-equalising) optimum. Against a brute-force
  // search over every integer split it is never BETTER (brute is the true max of the
  // floored sum) and never worse by more than the leg count — `Σ floor(outᵢ)` isn't
  // discretely concave, so the integer argmax can sit a couple of base units above the
  // marginal-equalising point. Two-pool cases ⇒ tolerance 2 base units (millionths).
  const TOL = 2n;
  const cases: [string, string, string, string, number, number][] = [
    // resTok0, resAda0, resTok1, resAda1, fee0, fee1
    ["1000", "1000", "1000", "1000", 0, 0],
    ["1000", "1000", "10000", "10000", 0, 0],
    ["1000", "2000", "3000", "2500", 30, 30],
    ["1500", "900", "4200", "5100", 30, 5],
    ["800", "800", "800", "800", 100, 30],
  ];
  for (const [rt0, ra0, rt1, ra1, f0, f1] of cases) {
    const pools = [tokAdaPool("p0", rt0, ra0, f0), tokAdaPool("p1", rt1, ra1, f1)];
    for (const amt of [50n, 137n, 400n]) {
      const r = planRoute(pools, "aa", "lovelace", amt.toString(), { tipLovelace: 0n });
      assert.ok(r);
      const brute = bruteBestTwo(pools, amt);
      const got = BigInt(r.amountOut);
      const label = `${rt0}/${ra0} f${f0} | ${rt1}/${ra1} f${f1} @ ${amt}`;
      assert.ok(got <= brute, `never beats brute (${got} ≤ ${brute}) for ${label}`);
      assert.ok(got >= brute - TOL, `within ${TOL} of brute (${got} ≥ ${brute - TOL}) for ${label}`);
      assert.equal(sumIn(r.legs), amt);
    }
  }
});

test("TIP GATE: a thin gain that no longer covers the extra tip drops the split", () => {
  const pools = [
    tokAdaPool("p0", "1000", "1000", 0),
    tokAdaPool("p1", "1000", "1000", 0),
  ];
  // Splitting 100 gains 94 − 90 = 4 ADA-units over one pool. tokenOut is ADA, so the tip
  // is already in output units.
  const cheap = planRoute(pools, "aa", "lovelace", "100", { tipLovelace: 3n });
  assert.ok(cheap);
  assert.equal(cheap.legs.length, 2, "gain 4 > 2×3−... still worth splitting at tip 3");

  const dear = planRoute(pools, "aa", "lovelace", "100", { tipLovelace: 5n });
  assert.ok(dear);
  assert.equal(dear.legs.length, 1, "gain 4 < extra tip 5 → stay on one pool");
  assert.equal(dear.amountOut, "90");
});

test("TIP GATE: a big enough trade still splits despite per-leg tips", () => {
  // ~1000-ADA pools (reserveAda = 1e9 lovelace); a 20%-of-pool trade has a ~15 ₳ impact
  // saving from spreading — easily clears a real 0.5 ₳ tip.
  const pools = [
    tokAdaPool("p0", "1000000000", "1000000000", 30),
    tokAdaPool("p1", "1000000000", "1000000000", 30),
  ];
  const r = planRoute(pools, "aa", "lovelace", "200000000", { tipLovelace: 500_000n });
  assert.ok(r);
  assert.equal(r.legs.length, 2);
  assert.ok(BigInt(r.amountOut) > BigInt(r.singleBestOut));
  assert.equal(sumIn(r.legs), 200000000n);
});

test("buying a token WITH ada splits too (tip priced via the pool spot rate)", () => {
  // tokenIn = ADA, tokenOut = TOK. Two equal deep pools; a big ADA buy should split.
  const pools = [
    tokAdaPool("p0", "1000000000", "1000000000", 30),
    tokAdaPool("p1", "1000000000", "1000000000", 30),
  ];
  const r = planRoute(pools, "lovelace", "aa", "200000000", { tipLovelace: 500_000n });
  assert.ok(r);
  assert.equal(r.legs.length, 2);
  assert.equal(sumIn(r.legs), 200000000n);
});

test("token↔token (no ADA leg) never splits in v1 — falls back to best single pool", () => {
  const tokTokPool = (id: string, ra: string, rb: string, fee: number): Pool => ({
    id,
    tokenA: TOK,
    tokenB: TKB,
    reserveA: ra,
    reserveB: rb,
    feeBps: fee,
  });
  const pools = [tokTokPool("p0", "1000", "1000", 0), tokTokPool("p1", "1000", "1000", 0)];
  const r = planRoute(pools, "aa", "bb", "100", { tipLovelace: 0n });
  assert.ok(r);
  assert.equal(r.legs.length, 1, "token/token: tip can't be priced → no split");
  assert.equal(r.amountOut, r.singleBestOut);
});

test("a sub-unit ADA tip is NOT rounded to free (tip gate stays armed)", () => {
  // tokenIn = ADA, tokenOut = TOK. Two equal pools where the tip→tokenOut conversion would
  // floor to 0 (reserveOut < reserveIn → num < den). At amt=36 the optimal split (18/18 →
  // 16 TOK) beats the single pool (15 TOK) by exactly 1, so with a *free* (floored-to-0) tip
  // the router would split; with the correct CEILING tip (1 TOK each) the 2 extra-leg cost
  // ties the 1-unit gain and the tie-break keeps it to a single leg.
  const adaTokPool = (id: string): Pool => ({
    id,
    tokenA: ADA,
    tokenB: TOK,
    reserveA: "200", // ADA (lovelace)
    reserveB: "100", // TOK
    feeBps: 0,
  });
  const pools = [adaTokPool("p0"), adaTokPool("p1")];
  const free = planRoute(pools, "lovelace", "aa", "36", { tipLovelace: 0n });
  assert.ok(free);
  assert.equal(free.legs.length, 2, "a zero tip splits for the +1 gain");
  assert.equal(free.amountOut, "16");

  const tipped = planRoute(pools, "lovelace", "aa", "36", { tipLovelace: 1n });
  assert.ok(tipped);
  assert.equal(tipped.legs.length, 1, "a 1-lovelace tip is priced (ceil) and gates the split");
  assert.equal(tipped.amountOut, "15");
});

test("deepest pool wins as the single-best baseline on a large trade", () => {
  // The deep pool has a slightly worse spot price but far more liquidity; on a big trade
  // it pays more than the shallow high-spot pool, so the no-split baseline picks it.
  const pools = [
    tokAdaPool("shallow", "1000", "1100", 0), // spot 1.1 ADA/TOK, thin
    tokAdaPool("deep", "100000", "100000", 0), // spot 1.0, deep
  ];
  const r = planRoute(pools, "aa", "lovelace", "5000", { tipLovelace: 0n });
  assert.ok(r);
  assert.equal(r.singleBestPoolId, "deep");
});

test("NEVER WORSE holds with >MAX_SUBSET_POOLS shards (best pool ranks last by spot)", () => {
  // 12 shallow, higher-spot pools + 1 deep, lower-spot pool. The deep pool ranks 13th by
  // marginal, so the top-12 subset search DROPS it — yet for a large trade it is the single
  // best pool. The single-best fallback must still pick it; without it the router would
  // return a thin split worth far less than one deep pool, breaking the never-worse promise.
  const pools: Pool[] = [];
  for (let i = 0; i < 12; i++) pools.push(tokAdaPool(`shallow${i}`, "1000", "1100", 0)); // spot 1.1, thin
  pools.push(tokAdaPool("deep", "1000000", "1000000", 0)); // spot 1.0, deep — sorts last
  const amt = 50_000n;
  const r = planRoute(pools, "aa", "lovelace", amt.toString(), { tipLovelace: 0n });
  assert.ok(r);
  const indepBest = bestSinglePool(pools, "aa", "lovelace", amt);
  assert.ok(BigInt(r.amountOut) >= indepBest, `never worse: ${r.amountOut} ≥ ${indepBest}`);
  assert.equal(r.singleBestPoolId, "deep");
  assert.equal(r.legs.length, 1, "the deep pool dwarfs the thin shards → collapses to it");
  assert.equal(r.legs[0].poolId, "deep");
});

test("a pool with fee ≥ 100% (γ ≤ 0) is rejected, never routed through", () => {
  const good = tokAdaPool("good", "1000", "1000", 30);
  const dead = tokAdaPool("dead", "1000", "1000", 10_000); // 100% fee → γ = 0, pays ≤ 0 out
  const r = planRoute([good, dead], "aa", "lovelace", "100", { tipLovelace: 0n });
  assert.ok(r);
  assert.equal(r.legs.length, 1);
  assert.equal(r.legs[0].poolId, "good");
  assert.equal(r.singleBestPoolId, "good");
  // With ONLY the dead pool there are no valid candidates → null (not a 0-output route).
  assert.equal(planRoute([dead], "aa", "lovelace", "100", { tipLovelace: 0n }), null);
});

test("FUZZ: 400 random configs — conserves + never worse than the best single pool", () => {
  // Wider net than the hand-picked cases: random pool counts, depths, fees, amounts, and
  // tips. Asserts the two load-bearing invariants on EVERY draw — conservation (legs sum to
  // the input) and never-worse (≥ an INDEPENDENT best single pool, even with a tip). Big
  // amounts/reserves are in range so the integer cleanup is exercised at scale.
  const r = rng(0xC0FFEE);
  for (let i = 0; i < 400; i++) {
    const n = randInt(r, 1, 5);
    const pools: Pool[] = [];
    for (let p = 0; p < n; p++) {
      pools.push(
        tokAdaPool(
          `p${p}`,
          String(randInt(r, 1_000, 5_000_000_000)), // TOK reserve
          String(randInt(r, 1_000, 5_000_000_000)), // ADA reserve
          [0, 5, 30, 100, 300][randInt(r, 0, 4)],
        ),
      );
    }
    const amt = BigInt(randInt(r, 1, 2_000_000_000));
    const tip = BigInt([0, 1, 100_000, 500_000, 5_000_000][randInt(r, 0, 4)]);
    const route = planRoute(pools, "aa", "lovelace", amt.toString(), { tipLovelace: tip });
    assert.ok(route, `route exists (seed draw ${i})`);
    const legSum = route.legs.reduce((s, l) => s + BigInt(l.amountIn), 0n);
    assert.equal(legSum, amt, `conservation (draw ${i}, n=${n}, amt=${amt})`);
    const indepBest = bestSinglePool(pools, "aa", "lovelace", amt);
    assert.ok(
      BigInt(route.amountOut) >= indepBest,
      `never worse (draw ${i}): ${route.amountOut} ≥ ${indepBest} (n=${n}, amt=${amt}, tip=${tip})`,
    );
    for (const l of route.legs) assert.ok(BigInt(l.amountIn) > 0n, `no dust leg (draw ${i})`);
  }
});

test("FUZZ: 200 small configs — gross output matches brute force within the floor slack", () => {
  // Small enough (≤3 pools, amt ≤ 90) to brute-force the true integer optimum and confirm
  // the router is OPTIMAL up to the floor-slack bound (≤ pool count base units) and never
  // exceeds the true max. tip=0 so the objective is pure gross output.
  const r = rng(0x5EED1);
  for (let i = 0; i < 200; i++) {
    const n = randInt(r, 1, 3);
    const pools: Pool[] = [];
    for (let p = 0; p < n; p++) {
      pools.push(
        tokAdaPool(
          `p${p}`,
          String(randInt(r, 50, 5_000)),
          String(randInt(r, 50, 5_000)),
          [0, 5, 30, 100][randInt(r, 0, 3)],
        ),
      );
    }
    const amt = BigInt(randInt(r, 1, 90));
    const route = planRoute(pools, "aa", "lovelace", amt.toString(), { tipLovelace: 0n });
    assert.ok(route, `route exists (draw ${i})`);
    const brute = bruteBestN(pools, "aa", "lovelace", amt);
    const got = BigInt(route.amountOut);
    assert.ok(got <= brute, `never beats the true max (draw ${i}): ${got} ≤ ${brute}`);
    assert.ok(
      got >= brute - BigInt(n),
      `within floor slack ${n} (draw ${i}): ${got} ≥ ${brute - BigInt(n)} (amt=${amt})`,
    );
  }
});

test("FUZZ: 200 small configs — the TIP-GATED leg count is net-optimal (brute force)", () => {
  // The tip=0 optimality test proves the split is optimal GIVEN a leg count; this proves the
  // router also chooses the right NUMBER of legs — it maximises Σ floor(out) − legs·tip. Sell
  // TOK→ADA so tokenOut is ADA and the per-leg tip (lovelace) IS the output-unit tip exactly.
  const r = rng(0x712ED);
  for (let i = 0; i < 200; i++) {
    const n = randInt(r, 1, 3);
    const pools: Pool[] = [];
    for (let p = 0; p < n; p++) {
      pools.push(
        tokAdaPool(
          `p${p}`,
          String(randInt(r, 50, 5_000)),
          String(randInt(r, 50, 5_000)),
          [0, 5, 30, 100][randInt(r, 0, 3)],
        ),
      );
    }
    const amt = BigInt(randInt(r, 1, 80));
    const tip = BigInt([0, 1, 5, 20, 100][randInt(r, 0, 4)]);
    const route = planRoute(pools, "aa", "lovelace", amt.toString(), { tipLovelace: tip });
    assert.ok(route, `route exists (draw ${i})`);
    const routerNet = BigInt(route.amountOut) - BigInt(route.legs.length) * tip;
    const bruteNet = bruteBestNetN(pools, "aa", "lovelace", amt, tip);
    assert.ok(
      routerNet <= bruteNet,
      `router net never beats the true max-net (draw ${i}): ${routerNet} ≤ ${bruteNet} (amt=${amt}, tip=${tip}, legs=${route.legs.length})`,
    );
    assert.ok(
      routerNet >= bruteNet - BigInt(n),
      `router net within floor slack ${n} of max-net (draw ${i}): ${routerNet} ≥ ${bruteNet - BigInt(n)} (amt=${amt}, tip=${tip})`,
    );
  }
});
