/**
 * Tests for the shared coin-selection helper (`coinSelect.ts`). Excluding collateral
 * from the funding set is a correctness requirement for every script spend — a tx that
 * uses one UTXO as both collateral and a regular input is rejected by the ledger. Run
 * with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { excludeCollateral, utxoRef } from "./coinSelect.ts";

/** Minimal UTXO-shaped fixture (only the fields the helper reads). */
function u(txHash: string, outputIndex: number) {
  return {
    input: { txHash, outputIndex },
    output: { address: "addr", amount: [] },
  } as unknown as Parameters<typeof utxoRef>[0];
}

test("utxoRef formats txHash#index", () => {
  assert.equal(utxoRef(u("abc", 0)), "abc#0");
  assert.equal(utxoRef(u("def", 7)), "def#7");
});

test("excludeCollateral removes every collateral UTXO from the funding set", () => {
  const utxos = [u("a", 0), u("b", 1), u("c", 0)];
  const collateral = [u("b", 1)];
  const out = excludeCollateral(utxos, collateral);
  assert.deepEqual(out.map(utxoRef), ["a#0", "c#0"]);
});

test("excludeCollateral matches on BOTH txHash and index (not txHash alone)", () => {
  // Same txHash, different index must NOT be excluded.
  const utxos = [u("a", 0), u("a", 1)];
  const out = excludeCollateral(utxos, [u("a", 1)]);
  assert.deepEqual(out.map(utxoRef), ["a#0"]);
});

test("excludeCollateral is a no-op when collateral is empty or disjoint", () => {
  const utxos = [u("a", 0), u("b", 0)];
  assert.equal(excludeCollateral(utxos, []).length, 2);
  assert.equal(excludeCollateral(utxos, [u("z", 9)]).length, 2);
});

test("excludeCollateral handles multiple collateral UTXOs", () => {
  const utxos = [u("a", 0), u("b", 0), u("c", 0), u("d", 0)];
  const out = excludeCollateral(utxos, [u("a", 0), u("c", 0)]);
  assert.deepEqual(out.map(utxoRef), ["b#0", "d#0"]);
});
