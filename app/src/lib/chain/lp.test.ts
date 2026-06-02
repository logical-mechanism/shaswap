/**
 * Tests for the pure LP builders (`lp.ts`) — the TS mirror of `spend.lp_action`.
 *
 * The fixtures are lifted verbatim from `contracts/lib/shaswap/lp_test.ak` so the
 * app's share math is proven equal to the validator's to the unit. Note the Aiken
 * helper convention: `pool_in(ada_res, tok_amt, held)` builds a pool with
 * `asset_a = tok` (reserve = tok_amt) and `asset_b = ada` (reserve = ada_res). We
 * reproduce that orientation here (and a token/token pool for the no-ADA case).
 *
 * Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeposit,
  buildWithdraw,
  isqrt,
  lpPositionValue,
  pairDeltaB,
  poolStats,
  type PoolView,
} from "./lp.ts";
import {
  ADA,
  assetFromUnit,
  type Credential,
  decodePoolDatum,
  encodePoolDatum,
  type PoolDatum,
  toCbor,
} from "./datums.ts";
import { MIN_LIQ, POOL_MIN_ADA, TOTAL_LP } from "./deployment.ts";
import type { Asset } from "@meshsdk/core";

// ---- fixtures (mirror lp_test.ak) ----

const TOK_UNIT = "3333333333333333333333333333333333333333333333333333333d" + "54";
const TOKB_UNIT = "888888888888888888888888888888888888888888888888888888ff" + "42";
const NFT_POLICY = "4444444444444444444444444444444444444444444444444444444e";
const NFT_UNIT = NFT_POLICY + "4e4654";
const LP_UNIT = NFT_POLICY + "4c50";
const CREATOR: Credential = { kind: "key", hash: "c0".repeat(28) };

/** `asset_a = tok`, `asset_b = ADA` (the standard lp_test datum + the live pool). */
const adaDatum: PoolDatum = {
  nft: assetFromUnit(NFT_UNIT),
  assetA: assetFromUnit(TOK_UNIT),
  assetB: ADA,
  feeNum: 3n,
  feeDen: 1000n,
  creator: CREATOR,
};

/** `asset_a = tok`, `asset_b = tokb` (the token/token pool). */
const ttDatum: PoolDatum = { ...adaDatum, assetB: assetFromUnit(TOKB_UNIT) };

/** Mirror `pool_val(ada_res, tok_amt, held)`: res_a = tok_amt, res_b = ada_res. */
function adaPool(adaRes: bigint, tokAmt: bigint, held: bigint): PoolView {
  const value: Asset[] = [
    { unit: "lovelace", quantity: (adaRes + POOL_MIN_ADA).toString() },
    { unit: NFT_UNIT, quantity: "1" },
    { unit: LP_UNIT, quantity: held.toString() },
  ];
  // Aiken drops a zero-qty asset; match that (first deposit has tok_amt = 0).
  if (tokAmt > 0n) value.push({ unit: TOK_UNIT, quantity: tokAmt.toString() });
  return { value, datum: adaDatum };
}

/** Mirror `tt_pool(res_a, res_b, held)`: lovelace is pure pool_min_ada overhead. */
function ttPool(resA: bigint, resB: bigint, held: bigint): PoolView {
  return {
    value: [
      { unit: "lovelace", quantity: POOL_MIN_ADA.toString() },
      { unit: TOK_UNIT, quantity: resA.toString() },
      { unit: TOKB_UNIT, quantity: resB.toString() },
      { unit: NFT_UNIT, quantity: "1" },
      { unit: LP_UNIT, quantity: held.toString() },
    ],
    datum: ttDatum,
  };
}

function valueMap(v: Asset[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of v) m[a.unit] = a.quantity;
  return m;
}

// ---- poolStats / isqrt ----

test("poolStats: ADA pool reserves carve out pool_min_ada; circ = total_lp − held", () => {
  const s = poolStats(adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n));
  assert.equal(s.resA, 200_000_000n); // tok
  assert.equal(s.resB, 100_000_000n); // ada (lovelace − pool_min_ada)
  assert.equal(s.circ, 1_000_000n);
  assert.equal(s.lpUnit, LP_UNIT);
  assert.equal(s.firstDeposit, false);
});

test("poolStats: token/token pool has no ADA reserve carve", () => {
  const s = poolStats(ttPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n));
  assert.equal(s.resA, 100_000_000n);
  assert.equal(s.resB, 200_000_000n);
});

test("isqrt is the integer floor sqrt (matches math.is_sqrt)", () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(25n), 5n);
  assert.equal(isqrt(44203n), 210n);
  assert.equal(isqrt(10n ** 16n), 100_000_000n); // 100M² = 1e16
  assert.equal(isqrt(10n ** 16n - 1n), 99_999_999n);
});

// ---- deposit (subsequent) — fixtures from deposit_ok / deposit_token_token ----

test("deposit_ok: 10% proportional deposit mints 100K LP, recreates the pool", () => {
  // in (ada 100M, tok 200M, circ 1M) → out (ada 110M, tok 220M, circ 1.1M)
  const view = adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n);
  const built = buildDeposit({ view, deltaA: 20_000_000n, deltaB: 10_000_000n });
  assert.equal(built.firstDeposit, false);
  assert.equal(built.lpToUser, 100_000n);
  assert.equal(built.circOut, 1_100_000n);
  assert.equal(built.lockLp, null);
  assert.deepEqual(valueMap(built.poolValue), {
    lovelace: (110_000_000n + POOL_MIN_ADA).toString(),
    [TOK_UNIT]: "220000000",
    [NFT_UNIT]: "1",
    [LP_UNIT]: (TOTAL_LP - 1_100_000n).toString(),
  });
});

test("deposit takes the min side: imbalanced Δ never overmints (overmint would need circ 1.2M)", () => {
  // Same Δ as deposit_ok but if a caller tried to claim more, the floor min caps it.
  const view = adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n);
  // Over-fund asset_a only: lp is bounded by the SHORT side (asset_b).
  const built = buildDeposit({ view, deltaA: 40_000_000n, deltaB: 10_000_000n });
  // floor(40M·1M/200M)=200K vs floor(10M·1M/100M)=100K → min 100K (not 300K).
  assert.equal(built.lpToUser, 100_000n);
  assert.equal(built.circOut, 1_100_000n);
});

test("deposit_token_token: 10% proportional into a token/token pool", () => {
  const view = ttPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n);
  const built = buildDeposit({ view, deltaA: 10_000_000n, deltaB: 20_000_000n });
  assert.equal(built.lpToUser, 100_000n);
  assert.deepEqual(valueMap(built.poolValue), {
    lovelace: POOL_MIN_ADA.toString(),
    [TOK_UNIT]: "110000000",
    [TOKB_UNIT]: "220000000",
    [NFT_UNIT]: "1",
    [LP_UNIT]: (TOTAL_LP - 1_100_000n).toString(),
  });
});

test("deposit rejects: zero/negative amounts, and a too-tight minLpOut", () => {
  const view = adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n);
  assert.throws(() => buildDeposit({ view, deltaA: 0n, deltaB: 10n }), /positive/);
  assert.throws(() => buildDeposit({ view, deltaA: -1n, deltaB: 10n }), /positive/);
  // tiny deposit that rounds to zero LP
  assert.throws(
    () => buildDeposit({ view, deltaA: 1n, deltaB: 1n }),
    /rounds to zero/,
  );
  // slippage guard: would receive 100K, ask for 100K+1
  assert.throws(
    () => buildDeposit({ view, deltaA: 20_000_000n, deltaB: 10_000_000n, minLpOut: 100_001n }),
    /slippage/,
  );
});

test("pairDeltaB rounds UP so the per-share backing holds on both sides", () => {
  const s = poolStats(adaPool(100_000_000n, 300_000_000n, TOTAL_LP - 1_000_000n));
  // res_a (tok) = 300M, res_b (ada) = 100M. Δa = 7 → Δb = ceil(7·100M/300M) = ceil(2.33) = 3.
  assert.equal(pairDeltaB(s, 7n), 3n);
});

// ---- withdraw — fixtures from withdraw_ok / withdraw_token_token ----

test("withdraw_ok: burning 100K LP returns 10% of both reserves", () => {
  // in (ada 100M, tok 200M, circ 1M) → out (ada 90M, tok 180M, circ 900K)
  const view = adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n);
  const built = buildWithdraw({ view, lpToBurn: 100_000n });
  assert.equal(built.recvA, 20_000_000n); // tok
  assert.equal(built.recvB, 10_000_000n); // ada
  assert.equal(built.circOut, 900_000n);
  assert.deepEqual(valueMap(built.poolValue), {
    lovelace: (90_000_000n + POOL_MIN_ADA).toString(),
    [TOK_UNIT]: "180000000",
    [NFT_UNIT]: "1",
    [LP_UNIT]: (TOTAL_LP - 900_000n).toString(),
  });
});

test("withdraw rejects: more than circulating, below min_liq, or below a slippage floor", () => {
  const view = adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n);
  assert.throws(() => buildWithdraw({ view, lpToBurn: 0n }), /positive/);
  assert.throws(() => buildWithdraw({ view, lpToBurn: 2_000_000n }), /more LP than circulating/);
  // circ_in 1M; burning all but 999 would leave circ 999 < min_liq 1000
  assert.throws(
    () => buildWithdraw({ view, lpToBurn: 1_000_000n - 999n }),
    /below min_liq/,
  );
  // slippage: recvA would be 20M, ask for more
  assert.throws(
    () => buildWithdraw({ view, lpToBurn: 100_000n, minAOut: 20_000_001n }),
    /slippage/,
  );
});

// ---- first deposit (circ == 0) — fixtures from first_deposit_ok ----

test("first_deposit_ok: circ_out = floor(sqrt(res_a·res_b)), locks min_liq", () => {
  // in (0, 0, total_lp) → out (ada 100M, tok 100M, circ 100M) + lock 1000
  const view = adaPool(0n, 0n, TOTAL_LP);
  const s = poolStats(view);
  assert.equal(s.circ, 0n);
  assert.equal(s.firstDeposit, true);

  const built = buildDeposit({ view, deltaA: 100_000_000n, deltaB: 100_000_000n });
  assert.equal(built.firstDeposit, true);
  assert.equal(built.circOut, 100_000_000n); // sqrt(1e16)
  assert.equal(built.lockLp, MIN_LIQ);
  assert.equal(built.lpToUser, 100_000_000n - MIN_LIQ); // depositor nets circ_out − min_liq
  assert.deepEqual(valueMap(built.poolValue), {
    lovelace: (100_000_000n + POOL_MIN_ADA).toString(),
    [TOK_UNIT]: "100000000",
    [NFT_UNIT]: "1",
    [LP_UNIT]: (TOTAL_LP - 100_000_000n).toString(),
  });
});

test("first deposit rejects when circ_out would not exceed min_liq", () => {
  // res_a · res_b small → sqrt ≤ min_liq
  const view = adaPool(0n, 0n, TOTAL_LP);
  assert.throws(
    () => buildDeposit({ view, deltaA: 1000n, deltaB: 1000n }), // sqrt(1e6)=1000 = min_liq
    /min_liq/,
  );
});

// ---- property: exactly-proportional deposit scales LP by the same factor ----

test("prop: scaling reserves & circ by m always mints circ·(m−1) (no overmint)", () => {
  const circIn = 1_000_000n;
  for (const m of [2n, 3n, 5n, 10n, 50n]) {
    for (const [adaRes, tokAmt] of [
      [137n, 991n],
      [1_000_000n, 1n],
      [50_000_000n, 123_456_789n],
    ] as const) {
      const view = adaPool(adaRes, tokAmt, TOTAL_LP - circIn);
      // proportional: scale each reserve by m ⇒ Δ = res·(m−1)
      const deltaA = tokAmt * (m - 1n); // asset_a = tok
      const deltaB = adaRes * (m - 1n); // asset_b = ada
      const built = buildDeposit({ view, deltaA, deltaB });
      assert.equal(built.lpToUser, circIn * (m - 1n), `m=${m} ada=${adaRes} tok=${tokAmt}`);
      assert.equal(built.circOut, circIn * m);
    }
  }
});

// ---- your-position valuation ----

test("lpPositionValue: proportional floored share of each reserve", () => {
  const s = poolStats(adaPool(100_000_000n, 200_000_000n, TOTAL_LP - 1_000_000n));
  // own 250K of 1M circulating = 25%
  assert.deepEqual(lpPositionValue(s, 250_000n), { a: 50_000_000n, b: 25_000_000n });
  assert.deepEqual(lpPositionValue(s, 0n), { a: 0n, b: 0n });
});

// ---- datum continuity backstop: encode→decode→encode is byte-stable ----

test("PoolDatum encode/decode round-trips byte-for-byte (datum continuity backstop)", () => {
  const cbor1 = toCbor(encodePoolDatum(adaDatum));
  const decoded = decodePoolDatum(cbor1);
  const cbor2 = toCbor(encodePoolDatum(decoded));
  assert.equal(cbor2, cbor1);
  assert.deepEqual(decoded, adaDatum);
});
