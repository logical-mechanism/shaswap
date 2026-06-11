/**
 * Pins the order/pool addresses to GOLDEN bech32 values for BOTH networks. The addresses
 * are derived in `deployment.ts` from the (network-independent) script hashes + the stake
 * tag `S`; this test pins that derivation to committed literals so a hash drift or a
 * derivation regression fails loudly — catching a mis-tagged order address before a single
 * lovelace is posted to the wrong place.
 *
 * The golden literals were computed once via `deriveBaseAddress(hash, S, networkId)` and
 * cross-checked: networkId 0 → `addr_test1…` (preprod/preview), networkId 1 → `addr1…`
 * (mainnet). Comparing the derivation to literals (not to the derived `deployment.ts`
 * exports) keeps the test honest — it's a golden pin, not a tautology — and independent of
 * `NEXT_PUBLIC_NETWORK` (it passes networkId explicitly), so it's green in every build.
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

// Golden order/pool addresses = base(payment = order/pool script, stake = `S`). Both networks
// run the same H-01 pool (Rev 29); only the bech32 network tag differs.
const PREPROD_ORDER =
  "addr_test1xrnl5x3ctgzvzqlvue6xhs2m3ecumuwvk6z5m0f4yna3frdrqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qlzjxy5";
const PREPROD_POOL =
  "addr_test1xp6hhf4h8y3texyzgesm7n0tjrn2qcgyzuzuqv4vua26l5arqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qvt5def";
const MAINNET_ORDER =
  "addr1x8nl5x3ctgzvzqlvue6xhs2m3ecumuwvk6z5m0f4yna3frdrqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84qu50xgt";
const MAINNET_POOL =
  "addr1x96hhf4h8y3texyzgesm7n0tjrn2qcgyzuzuqv4vua26l5arqk3ulkp58sp6hlaqau4n4dk82e2h5rw9lv5ccarjt84q0afd4k";

test("ORDER_ADDR derivation pins to golden preprod address", () => {
  assert.equal(deriveBaseAddress(ORDER_SCRIPT_HASH, SETTLEMENT_HASH, 0), PREPROD_ORDER);
});

test("POOL_ADDR derivation pins to golden preprod address", () => {
  assert.equal(deriveBaseAddress(POOL_SCRIPT_HASH, SETTLEMENT_HASH, 0), PREPROD_POOL);
});

test("ORDER_ADDR derivation pins to golden mainnet address", () => {
  assert.equal(deriveBaseAddress(ORDER_SCRIPT_HASH, SETTLEMENT_HASH, 1), MAINNET_ORDER);
});

test("POOL_ADDR derivation pins to golden mainnet address", () => {
  assert.equal(deriveBaseAddress(POOL_SCRIPT_HASH, SETTLEMENT_HASH, 1), MAINNET_POOL);
});

// The module's ACTIVE exports default to preprod (no NEXT_PUBLIC_NETWORK under the runner),
// so they must equal the preprod goldens — wiring check on the derived `deployment.ts` exports.
test("deployment.ts active addresses default to the preprod goldens", () => {
  assert.equal(ORDER_ADDR, PREPROD_ORDER);
  assert.equal(POOL_ADDR, PREPROD_POOL);
});
