/**
 * Pins the committed order/pool addresses in `deployment.ts` to the canonical
 * derivation from their script hashes + the stake tag `S`. If a hash drifts or the
 * derivation logic regresses, this fails — catching a mis-tagged order address before
 * a single lovelace is posted to the wrong place.
 *
 * Run with: `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBaseAddress } from "./address.ts";
import {
  ORDER_ADDR,
  ORDER_SCRIPT_HASH,
  POOL_ADDR,
  POOL_SCRIPT_HASH,
  SETTLEMENT_HASH,
} from "./deployment.ts";

test("ORDER_ADDR = base(order script, S stake) on preprod", () => {
  assert.equal(
    deriveBaseAddress(ORDER_SCRIPT_HASH, SETTLEMENT_HASH, 0),
    ORDER_ADDR,
  );
});

test("POOL_ADDR = base(pool script, S stake) on preprod", () => {
  assert.equal(
    deriveBaseAddress(POOL_SCRIPT_HASH, SETTLEMENT_HASH, 0),
    POOL_ADDR,
  );
});
