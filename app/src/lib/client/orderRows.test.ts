/**
 * Tests for merging the on-chain order set with the local activity log. Run with
 * `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPending, mergeRows, PENDING_MS } from "./orderRows.ts";

const tok = (ticker: string, decimals = 0) => ({
  unit: ticker.toLowerCase(),
  ticker,
  name: ticker,
  decimals,
});

const live = (ref: string, partial = false) => ({
  ref,
  tokenIn: tok("TEST"),
  tokenOut: tok("ADA", 6),
  amountIn: "100",
  minOut: "50",
  status: "open" as const,
  partial,
});

const recent = (ref: string, ts: number, reclaimTx?: string) => ({
  ref,
  txHash: ref.split("#")[0],
  inUnit: "test",
  inTicker: "TEST",
  inDecimals: 0,
  outTicker: "ADA",
  outDecimals: 6,
  amountIn: "100",
  minOut: "50",
  partial: false,
  ts,
  reclaimTx,
});

test("live order → open + reclaimable", () => {
  const rows = mergeRows([live("a#0", true)], [], 1_000_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "open");
  assert.equal(rows[0].canReclaim, true);
  assert.equal(rows[0].partial, true);
});

test("recent post not yet on-chain → pending (then settled after the window)", () => {
  const now = 10_000_000;
  const fresh = mergeRows([], [recent("b#0", now - 1000)], now);
  assert.equal(fresh[0].status, "pending");
  assert.equal(fresh[0].canReclaim, false);
  assert.ok(hasPending(fresh));

  const old = mergeRows([], [recent("b#0", now - PENDING_MS - 1)], now);
  assert.equal(old[0].status, "settled");
  assert.equal(hasPending(old), false);
});

test("a live entry that we reclaimed locally shows as reclaimed (chain lag)", () => {
  const now = 10_000_000;
  const rows = mergeRows(
    [live("c#0")],
    [recent("c#0", now - 1000, "reclaimtxhash")],
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "reclaimed");
  assert.equal(rows[0].canReclaim, false);
  assert.equal(rows[0].reclaimTx, "reclaimtxhash");
});

test("live entry dedups its recent counterpart and is ordered first", () => {
  const now = 10_000_000;
  const rows = mergeRows(
    [live("d#0")],
    [recent("d#0", now - 1000), recent("e#0", now - PENDING_MS - 1)],
    now,
  );
  // d#0 once (open), e#0 settled; pending/open before settled
  assert.deepEqual(
    rows.map((r) => [r.ref, r.status]),
    [
      ["d#0", "open"],
      ["e#0", "settled"],
    ],
  );
});
