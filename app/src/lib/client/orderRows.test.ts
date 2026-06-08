/**
 * Tests for merging the on-chain order set with the local activity log. Run with
 * `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPending, mergeRows, OBSERVE_FALLBACK_MS } from "./orderRows.ts";

const tok = (ticker: string, decimals = 0) => ({
  unit: ticker.toLowerCase(),
  ticker,
  name: ticker,
  decimals,
});

const live = (ref: string, partial = false, deadline: string | null = null) => ({
  ref,
  tokenIn: tok("TEST"),
  tokenOut: tok("ADA", 6),
  amountIn: "100",
  minOut: "50",
  status: "open" as const,
  partial,
  deadline,
});

const recent = (
  ref: string,
  ts: number,
  opts: { reclaimTx?: string; seenLive?: number } = {},
) => ({
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
  seenLive: opts.seenLive,
  reclaimTx: opts.reclaimTx,
});

test("live order → open + reclaimable", () => {
  const rows = mergeRows([live("a#0", true)], [], 1_000_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "open");
  assert.equal(rows[0].canReclaim, true);
  assert.equal(rows[0].partial, true);
});

test("a live order's settle-by deadline is carried onto the row", () => {
  const rows = mergeRows([live("a#0", false, "1750000000000")], [], 1_000_000);
  assert.equal(rows[0].deadline, "1750000000000");

  // A recent-log-only row (no live counterpart) carries no deadline — the log doesn't store it.
  const pendingOnly = mergeRows([], [recent("b#0", 999_000)], 1_000_000);
  assert.equal(pendingOnly[0].deadline, undefined);
});

test("recent post never observed on-chain stays pending past the old 3-min cutoff", () => {
  const now = 10_000_000;
  // A fresh, unseen post is pending and keeps the auto-refresh alive.
  const fresh = mergeRows([], [recent("b#0", now - 1000)], now);
  assert.equal(fresh[0].status, "pending");
  assert.equal(fresh[0].canReclaim, false);
  assert.ok(hasPending(fresh));

  // Indexer lag: 5 min old, still never seen on-chain → MUST remain pending (the old
  // behaviour flipped this to a terminal "settled" and killed the poll).
  const lagging = mergeRows([], [recent("b#0", now - 5 * 60 * 1000)], now);
  assert.equal(lagging[0].status, "pending");
  assert.ok(hasPending(lagging));

  // Fallback: never seen and very old → terminal, so a dropped tx stops polling.
  const stale = mergeRows([], [recent("b#0", now - OBSERVE_FALLBACK_MS - 1)], now);
  assert.equal(stale[0].status, "completed");
  assert.equal(hasPending(stale), false);
});

test("once seen on-chain, a later disappearance is the terminal signal", () => {
  const now = 10_000_000;
  // Seen live and still live → open (live set is authoritative).
  const stillLive = mergeRows(
    [live("c#0")],
    [recent("c#0", now - 1000, { seenLive: now - 500 })],
    now,
  );
  assert.equal(stillLive[0].status, "open");

  // Seen live before, now gone from the live set → completed (even if young).
  const gone = mergeRows([], [recent("c#0", now - 1000, { seenLive: now - 500 })], now);
  assert.equal(gone[0].status, "completed");
  assert.equal(hasPending(gone), false);
});

test("a live entry that we reclaimed locally shows as reclaimed (chain lag)", () => {
  const now = 10_000_000;
  const rows = mergeRows(
    [live("c#0")],
    [recent("c#0", now - 1000, { reclaimTx: "reclaimtxhash" })],
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
    [
      recent("d#0", now - 1000),
      recent("e#0", now - 1000, { seenLive: now - 800 }),
    ],
    now,
  );
  // d#0 once (open), e#0 completed (seen then gone); open before completed
  assert.deepEqual(
    rows.map((r) => [r.ref, r.status]),
    [
      ["d#0", "open"],
      ["e#0", "completed"],
    ],
  );
});
