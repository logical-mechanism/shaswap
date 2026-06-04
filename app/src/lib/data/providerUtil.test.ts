/**
 * Tests for the pure provider helpers (`providerUtil.ts`): fee→bps conversion and the
 * retry classifier (which decides whether a Blockfrost failure is transient). Run with
 * `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { feeToBps, httpStatus, isRetriable } from "./providerUtil.ts";

test("feeToBps converts fee_num/fee_den to basis points", () => {
  assert.equal(feeToBps(3n, 1000n), 30);
  assert.equal(feeToBps(0n, 1n), 0);
  assert.equal(feeToBps(1n, 100n), 100);
  assert.equal(feeToBps(5n, 0n), 0); // guard: den <= 0
});

test("isRetriable: 429 / 5xx from an object status retry", () => {
  assert.ok(isRetriable({ status: 429 }));
  assert.ok(isRetriable({ status_code: 503 }));
  assert.ok(isRetriable({ status: 500 }));
});

test("isRetriable: status parsed out of a JSON-string error (Blockfrost shape)", () => {
  assert.ok(isRetriable(JSON.stringify({ status_code: 429, message: "rate limited" })));
  assert.ok(isRetriable(JSON.stringify({ status: 502 })));
});

test("isRetriable: keyword fallback for raw network blips", () => {
  assert.ok(isRetriable("fetch failed"));
  assert.ok(isRetriable(new Error("ETIMEDOUT connecting")));
  assert.ok(isRetriable("Too Many Requests"));
});

test("isRetriable: 4xx (non-429) and tx/validation errors are NOT retried", () => {
  assert.equal(isRetriable({ status: 404 }), false);
  assert.equal(isRetriable({ status: 400 }), false);
  assert.equal(isRetriable(new Error("ScriptFailure BadInputsUTxO")), false);
  assert.equal(isRetriable("nope"), false);
});

test("httpStatus: from an object status / status_code", () => {
  assert.equal(httpStatus({ status: 404 }), 404);
  assert.equal(httpStatus({ status_code: 502 }), 502);
});

test("httpStatus: parsed out of a JSON-string error (Blockfrost shape)", () => {
  assert.equal(httpStatus(JSON.stringify({ status_code: 404, message: "Not Found" })), 404);
  assert.equal(httpStatus(JSON.stringify({ status: 200 })), 200);
});

test("httpStatus: undefined for a statusless network blip", () => {
  assert.equal(httpStatus("fetch failed"), undefined);
  assert.equal(httpStatus(new Error("ETIMEDOUT connecting")), undefined);
});
