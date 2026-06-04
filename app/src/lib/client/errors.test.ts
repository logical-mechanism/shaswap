/**
 * Tests for the wallet/provider error → user-message mapper. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toUserMessage } from "./errors.ts";
import { networkLabel } from "../config.ts";

test("user-declined (CIP-30 code 2 or text) → rejected message", () => {
  assert.match(toUserMessage({ code: 2, info: "user declined" }), /rejected/i);
  assert.match(toUserMessage(new Error("Transaction declined")), /rejected/i);
});

test("already-spent inputs → refresh message, not raw BadInputsUTxO", () => {
  const m = toUserMessage(new Error("ScriptFailure BadInputsUTxO ..."));
  assert.match(m, /already.*spent|refresh/i);
  assert.doesNotMatch(m, /BadInputsUTxO/);
});

test("CIP-30 code 1 with a node error is NOT mislabeled as a user rejection", () => {
  // code 1 = ProofGeneration/Refused-by-node, never a cancellation — map by content.
  const m = toUserMessage({ code: 1, info: "BadInputsUTxO at index 0" });
  assert.doesNotMatch(m, /rejected/i);
  assert.match(m, /already.*spent|refresh/i);
});

test("insufficient funds and collateral map to their own messages", () => {
  assert.match(toUserMessage("UTxO Balance Insufficient"), /not enough funds/i);
  assert.match(
    toUserMessage(new Error("no collateral inputs")),
    /collateral/i,
  );
});

test("wrong-network message names the active network from config", () => {
  const m = toUserMessage(new Error("Wallet network magic mismatch"));
  assert.match(m, /different network/i);
  assert.ok(m.includes(networkLabel()));
});

test("script-integrity / cost-model mismatch → params-changed message (not raw)", () => {
  const m = toUserMessage(
    new Error("Mismatch in the script integrity hash / cost model"),
  );
  assert.match(m, /network parameters changed|refresh/i);
  assert.doesNotMatch(m, /integrity hash/i);
});

test("provider/indexer unavailable (5xx / fetch failed) → data-service message", () => {
  assert.match(toUserMessage(new Error("Request failed (502 Bad Gateway)")), /data service/i);
  assert.match(toUserMessage(new Error("fetch failed")), /data service/i);
  assert.match(toUserMessage("429 Too Many Requests"), /data service/i);
});

test("unknown errors fall back to a trimmed original", () => {
  assert.equal(toUserMessage("a weird thing happened"), "a weird thing happened");
  assert.equal(toUserMessage(""), "Pip’s not sure what happened there — give it another go.");
  const long = "x".repeat(400);
  assert.ok(toUserMessage(long).length <= 181);
});
