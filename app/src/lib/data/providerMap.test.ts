/**
 * Tests for the pure provider mapping helpers (`providerMap.ts`): reading a reserve out
 * of a pool value (with the ADA-side `pool_min_ada` carve-out), and mapping an order
 * UTXO + datum into a UI `WalletPosition`. These are the decode-side mirror of the order
 * builder — a wrong carve-out misprices every quote, and a wrong sell_a→token mapping
 * shows the user the wrong pair. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asset, UTxO } from "@meshsdk/core";
import { qtyOfUnit, reserveOf, toPosition } from "./providerMap.ts";
import { ADA, type AssetId, type OrderDatum } from "../chain/datums.ts";
import { POOL_MIN_ADA } from "../chain/deployment.ts";
import type { Pool, TokenInfo } from "./types.ts";

const TEST_POLICY = "8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a";
const TEST_NAME = "54455354"; // "TEST"
const TEST_UNIT = TEST_POLICY + TEST_NAME;
const TEST_ASSET: AssetId = { policy: TEST_POLICY, name: TEST_NAME };

const NFT_UNIT =
  "1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d04e4654";
const NFT_ASSET: AssetId = {
  policy: "1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d0",
  name: "4e4654",
};

function val(...pairs: [string, bigint][]): Asset[] {
  return pairs.map(([unit, q]) => ({ unit, quantity: q.toString() }));
}

test("qtyOfUnit reads a unit's quantity, 0 when absent", () => {
  const v = val(["lovelace", 5_000_000n], [TEST_UNIT, 42n]);
  assert.equal(qtyOfUnit(v, "lovelace"), 5_000_000n);
  assert.equal(qtyOfUnit(v, TEST_UNIT), 42n);
  assert.equal(qtyOfUnit(v, "deadbeef"), 0n);
  assert.equal(qtyOfUnit([], "lovelace"), 0n);
});

test("reserveOf carves pool_min_ada out of the ADA side only", () => {
  const v = val(["lovelace", 861_338_911n], [TEST_UNIT, 1_200_000_000n]);
  // ADA side: quantity − pool_min_ada
  assert.equal(reserveOf(v, ADA), 861_338_911n - POOL_MIN_ADA);
  // token side: untouched
  assert.equal(reserveOf(v, TEST_ASSET), 1_200_000_000n);
});

test("reserveOf floors a sub-min-ADA value to 0 (never underflows negative)", () => {
  // less ADA than pool_min_ada → reserve clamps to 0, not a negative bigint
  const tiny = val(["lovelace", POOL_MIN_ADA - 1n]);
  assert.equal(reserveOf(tiny, ADA), 0n);
  // exactly pool_min_ada → 0
  assert.equal(reserveOf(val(["lovelace", POOL_MIN_ADA]), ADA), 0n);
  // a token side that is simply absent reads as 0
  assert.equal(reserveOf(val(["lovelace", 10_000_000n]), TEST_ASSET), 0n);
});

// ---- toPosition: sell_a + the pool pair → (tokenIn, tokenOut) ----

const ADA_INFO: TokenInfo = { unit: "lovelace", ticker: "ADA", name: "Cardano", decimals: 6 };
const TEST_INFO: TokenInfo = { unit: TEST_UNIT, ticker: "TEST", name: "Test", decimals: 0 };

// asset_a = ADA, asset_b = TEST (a real preprod-style orientation).
const POOL: Pool = {
  id: NFT_UNIT,
  tokenA: ADA_INFO,
  tokenB: TEST_INFO,
  reserveA: "861338911",
  reserveB: "1200000000",
  feeBps: 30,
};

function order(over: Partial<OrderDatum> = {}): OrderDatum {
  return {
    owner: { kind: "key", hash: "ab".repeat(28) },
    ownerStake: null,
    poolNft: NFT_ASSET,
    sellA: true,
    sellAmount: 100_000_000n,
    limit: 50_000_000n,
    tip: 2_000_000n,
    partial: false,
    deadline: null,
    ...over,
  };
}

function utxo(txHash = "ff".repeat(32), outputIndex = 0): UTxO {
  return {
    input: { txHash, outputIndex },
    output: { address: "addr_test1...", amount: [] },
  } as unknown as UTxO;
}

test("toPosition maps sell_a=true → (tokenA in, tokenB out)", () => {
  const p = toPosition(utxo("aa".repeat(32), 1), order({ sellA: true }), POOL);
  assert.equal(p.tokenIn.unit, ADA_INFO.unit);
  assert.equal(p.tokenOut.unit, TEST_INFO.unit);
  assert.equal(p.ref, `${"aa".repeat(32)}#1`);
  assert.equal(p.amountIn, "100000000");
  assert.equal(p.minOut, "50000000");
  assert.equal(p.status, "open");
  assert.equal(p.partial, false);
});

test("toPosition maps sell_a=false → (tokenB in, tokenA out)", () => {
  const p = toPosition(utxo(), order({ sellA: false, partial: true }), POOL);
  assert.equal(p.tokenIn.unit, TEST_INFO.unit);
  assert.equal(p.tokenOut.unit, ADA_INFO.unit);
  assert.equal(p.partial, true);
});

test("toPosition shows placeholders for an orphan order (pool not found)", () => {
  const p = toPosition(utxo(), order({ sellA: true }), undefined);
  // Both sides fall back to the unknown-pool placeholder (still reclaimable).
  assert.equal(p.tokenIn.ticker, "?");
  assert.equal(p.tokenOut.ticker, "?");
  assert.equal(p.tokenIn.unit, NFT_UNIT); // placeholder unit = the pool NFT unit
  assert.equal(p.status, "open");
});
