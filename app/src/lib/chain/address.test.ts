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

// Golden order/pool addresses = base(payment = order/pool script, stake = `S`).
const PREPROD_ORDER =
  "addr_test1xzqpc7jvgf5tnpksmlvsqy8wt4ts3svtrxlysk6nazxj9u490hn6jxg6k42yzuegwyvlwgphynpd0fasg47nva29yy0q4qj5a7";
const PREPROD_POOL =
  "addr_test1xpzz0muy20c6ed86cwzyl0ruxjzjlcvguj4enula5pa4xwa90hn6jxg6k42yzuegwyvlwgphynpd0fasg47nva29yy0qvte56r";
const MAINNET_ORDER =
  "addr1xxqpc7jvgf5tnpksmlvsqy8wt4ts3svtrxlysk6nazxj9u490hn6jxg6k42yzuegwyvlwgphynpd0fasg47nva29yy0qkk053p";
const MAINNET_POOL =
  "addr1x9zz0muy20c6ed86cwzyl0ruxjzjlcvguj4enula5pa4xwa90hn6jxg6k42yzuegwyvlwgphynpd0fasg47nva29yy0q0ay5ku";

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
