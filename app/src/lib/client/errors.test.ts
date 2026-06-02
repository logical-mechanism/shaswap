/**
 * Tests for the wallet/provider error → user-message mapper. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toUserMessage } from "./errors.ts";

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

test("unknown errors fall back to a trimmed original", () => {
  assert.equal(toUserMessage("a weird thing happened"), "a weird thing happened");
  assert.equal(toUserMessage(""), "Something went wrong. Please try again.");
  const long = "x".repeat(400);
  assert.ok(toUserMessage(long).length <= 181);
});
