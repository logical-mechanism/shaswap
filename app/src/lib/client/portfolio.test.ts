/**
 * Tests for the Portfolio summary aggregation. Run with `npm test` (the Node runner over
 * `*.test.ts`). Pure logic only — no DOM, no wallet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { countResting, summarizeWalletTokens } from "./portfolio.ts";

const tok = (unit: string, ticker: string) => ({
  unit,
  ticker,
  name: ticker,
  decimals: 0,
});

test("countResting counts only open (resting) rows", () => {
  assert.equal(countResting([]), 0);
  assert.equal(
    countResting([
      { status: "open" },
      { status: "pending" },
      { status: "open" },
      { status: "completed" },
      { status: "reclaimed" },
    ]),
    2,
  );
  // A set with no live rows → zero resting.
  assert.equal(
    countResting([{ status: "completed" }, { status: "reclaimed" }]),
    0,
  );
});

test("summarizeWalletTokens: an empty / absent wallet → zero", () => {
  assert.deepEqual(summarizeWalletTokens([], [tok("u1", "ONE")]), {
    count: 0,
    tickers: [],
    otherCount: 0,
  });
  assert.deepEqual(summarizeWalletTokens(undefined, [tok("u1", "ONE")]), {
    count: 0,
    tickers: [],
    otherCount: 0,
  });
});

test("summarizeWalletTokens: counts only recognised, non-ADA, positive holdings", () => {
  const tokens = [tok("lovelace", "ADA"), tok("u1", "ONE"), tok("u2", "TWO"), tok("u3", "THREE")];
  const assets = [
    { unit: "u1", quantity: "5" }, // recognised, positive → counted
    { unit: "u3", quantity: "1" }, // recognised, positive → counted
    { unit: "u_unknown", quantity: "9" }, // not in the registry → other, not named
    { unit: "lovelace", quantity: "1000000" }, // ADA → skipped (shown separately)
    { unit: "u2", quantity: "0" }, // zero quantity → ignored entirely
  ];
  assert.deepEqual(summarizeWalletTokens(assets, tokens), {
    count: 2,
    tickers: ["ONE", "THREE"],
    otherCount: 1,
  });
});

test("summarizeWalletTokens: unrecognised holdings (NFTs / unknown tokens) count as 'other'", () => {
  const tokens = [tok("lovelace", "ADA"), tok("u1", "ONE")];
  const assets = [
    { unit: "u1", quantity: "5" }, // recognised
    { unit: "policy.nft", quantity: "1" }, // an NFT — unrecognised
    { unit: "unknown_ft", quantity: "100" }, // a fungible the registry doesn't name
  ];
  assert.deepEqual(summarizeWalletTokens(assets, tokens), {
    count: 1,
    tickers: ["ONE"],
    otherCount: 2,
  });
});

test("summarizeWalletTokens: tickers follow registry order, not wallet order", () => {
  const tokens = [tok("a", "AAA"), tok("b", "BBB"), tok("c", "CCC")];
  const assets = [
    { unit: "c", quantity: "1" },
    { unit: "a", quantity: "1" },
  ];
  assert.deepEqual(summarizeWalletTokens(assets, tokens).tickers, ["AAA", "CCC"]);
});

test("summarizeWalletTokens: a unit split across entries is counted once", () => {
  const tokens = [tok("u1", "ONE")];
  const assets = [
    { unit: "u1", quantity: "3" },
    { unit: "u1", quantity: "4" },
  ];
  assert.deepEqual(summarizeWalletTokens(assets, tokens), {
    count: 1,
    tickers: ["ONE"],
    otherCount: 0,
  });
});

test("summarizeWalletTokens: a malformed quantity counts as zero (ignored)", () => {
  const tokens = [tok("u1", "ONE")];
  assert.deepEqual(summarizeWalletTokens([{ unit: "u1", quantity: "oops" }], tokens), {
    count: 0,
    tickers: [],
    otherCount: 0,
  });
});

test("summarizeWalletTokens: exact past 2^53 (BigInt, not Number)", () => {
  const tokens = [tok("u1", "ONE")];
  // A held amount well beyond Number.MAX_SAFE_INTEGER is still simply > 0 → counted.
  assert.deepEqual(
    summarizeWalletTokens([{ unit: "u1", quantity: "9007199254740993" }], tokens),
    { count: 1, tickers: ["ONE"], otherCount: 0 },
  );
});
