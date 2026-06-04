/**
 * Tests for the verified-pool surface: it is a UI-only trust hint that must FAIL CLOSED
 * (unknown / undefined → not verified) and never throw. Run with `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isVerifiedPool, verifiedPoolCount } from "./verifiedPools.ts";

test("fails closed: unknown and undefined pools are not verified", () => {
  assert.equal(isVerifiedPool(undefined), false);
  assert.equal(isVerifiedPool(""), false);
  assert.equal(isVerifiedPool("deadbeef".repeat(7) + "4e4654"), false);
});

test("count is a non-negative number (default allowlist is empty pre-launch)", () => {
  assert.ok(Number.isInteger(verifiedPoolCount));
  assert.ok(verifiedPoolCount >= 0);
});
