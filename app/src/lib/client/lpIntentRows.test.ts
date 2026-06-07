/**
 * Tests for `mergeLpIntentRows` — the LP-intent surface's live+local merge: the post →
 * pending → fulfilled/completed → reclaimed lifecycle, and that a locally-reclaimed intent is
 * never re-offered as a clickable "open" while the chain catches up. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLpIntentRows } from "./lpIntentRows.ts";
import type { RecentLpIntent } from "./lpIntentActivity.ts";
import { OBSERVE_FALLBACK_MS } from "./orderRows.ts";
import type { LpIntentPosition, TokenInfo } from "@/lib/data";

const ADA: TokenInfo = { unit: "lovelace", ticker: "ADA", name: "Cardano", decimals: 6 };
const TEST: TokenInfo = { unit: "tok", ticker: "TEST", name: "Test", decimals: 0 };
const POOL_NFT = "1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d04e4654";

function live(ref: string, action: "deposit" | "withdraw"): LpIntentPosition {
  return {
    ref,
    poolNft: POOL_NFT,
    action,
    tokenA: ADA,
    tokenB: TEST,
    lp: action === "withdraw" ? "250000" : undefined,
    depositA: action === "deposit" ? "50000000" : undefined,
    depositB: action === "deposit" ? "70000000" : undefined,
    minA: "0",
    minB: "0",
    minShares: "0",
    tip: "1000000",
    deadline: null,
  };
}

function recent(over: Partial<RecentLpIntent>): RecentLpIntent {
  return {
    ref: "r#0",
    txHash: "r",
    poolNft: POOL_NFT,
    action: "withdraw",
    aTicker: "ADA",
    aDecimals: 6,
    bTicker: "TEST",
    bDecimals: 0,
    lp: "250000",
    tip: "1000000",
    ts: 1000,
    ...over,
  };
}

test("a live intent is open + reclaimable", () => {
  const rows = mergeLpIntentRows([live("a#0", "withdraw")], [], 2000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "open");
  assert.equal(rows[0].canReclaim, true);
  assert.equal(rows[0].lp, "250000");
});

test("a just-posted intent not yet on-chain is pending (never reclaimable)", () => {
  const r = recent({ ref: "p#0", txHash: "p", ts: 1000 });
  const rows = mergeLpIntentRows([], [r], 1000 + 60_000); // within OBSERVE_FALLBACK
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].canReclaim, false);
});

test("seen-live then gone from the live set is completed", () => {
  const r = recent({ ref: "c#0", txHash: "c", ts: 1000, seenLive: 1500 });
  const rows = mergeLpIntentRows([], [r], 9_999_999);
  assert.equal(rows[0].status, "completed");
});

test("never-seen post past the fallback window is completed (not stuck pending)", () => {
  const r = recent({ ref: "f#0", txHash: "f", ts: 1000 });
  const rows = mergeLpIntentRows([], [r], 1000 + OBSERVE_FALLBACK_MS + 1);
  assert.equal(rows[0].status, "completed");
});

test("a locally-reclaimed intent shows reclaimed and is NOT duplicated by its live row", () => {
  const r = recent({ ref: "x#0", txHash: "x", reclaimTx: "rtx", reclaimTs: 1500, seenLive: 1200 });
  const rows = mergeLpIntentRows([live("x#0", "withdraw")], [r], 2000);
  assert.equal(rows.length, 1); // the live row is suppressed in favour of the reclaimed entry
  assert.equal(rows[0].status, "reclaimed");
  assert.equal(rows[0].reclaimTx, "rtx");
  assert.equal(rows[0].canReclaim, false);
});

test("rows are ordered pending → open → reclaimed → completed", () => {
  const rows = mergeLpIntentRows(
    [live("open#0", "deposit")],
    [
      recent({ ref: "pending#0", txHash: "p", ts: 9_999_000 }),
      recent({ ref: "done#0", txHash: "d", ts: 1000, seenLive: 1100 }),
      recent({ ref: "back#0", txHash: "b", reclaimTx: "t", seenLive: 1100, reclaimTs: 1200 }),
    ],
    9_999_000 + 1000,
  );
  assert.deepEqual(
    rows.map((r) => r.status),
    ["pending", "open", "reclaimed", "completed"],
  );
});
