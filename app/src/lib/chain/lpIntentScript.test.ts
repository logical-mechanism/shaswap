/**
 * Pins the derived `lp_intent` script hash + its ENTERPRISE addresses to GOLDEN values (the
 * LP analogue of `address.test.ts`). The hash is `applyParamsToScript(LP_INTENT_COMPILED_CODE,
 * [Script(SETTLEMENT_HASH)])` then `resolveScriptHash`; the addresses are the enterprise
 * (stake = None) form for each network. Comparing the derivation to committed literals catches
 * a compiled-code or `S` drift before a single lovelace is posted to the wrong place — and
 * documents the placeholder values that finalise at the Phase-4 redeploy (when `SETTLEMENT_HASH`
 * moves to the post-audit `S` and these goldens update alongside the order/pool ones).
 *
 * Run with: `npm run test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lpIntentAddress, lpIntentScriptHash } from "./lpIntentScript.ts";

// Golden values for the deployed (post-audit Rev 24) `S = a305a3cf…`. They move with `S` at
// any future redeploy, exactly as ORDER_ADDR/POOL_ADDR do — the pin is a drift guard, not a
// permanent identity. Cross-checked against `cardano-cli` at the preprod deploy.
const GOLDEN_HASH = "fa885b037442ac10e65e7b1aeb6056f350446446ea51d92878240e5d";
const GOLDEN_PREPROD =
  "addr_test1wragskcrw3p2cy8xtea346mq2me4q3rygm49rkfg0qjquhg9uug7c";
const GOLDEN_MAINNET =
  "addr1w8agskcrw3p2cy8xtea346mq2me4q3rygm49rkfg0qjquhg75g53a";

test("lp_intent script hash derives to the golden", () => {
  assert.equal(lpIntentScriptHash(), GOLDEN_HASH);
});

test("lp_intent enterprise address pins (preprod + mainnet)", () => {
  assert.equal(lpIntentAddress(0), GOLDEN_PREPROD);
  assert.equal(lpIntentAddress(1), GOLDEN_MAINNET);
});

test("lp_intent address is ENTERPRISE (stake = None, never S-tagged)", () => {
  // The enterprise script-hash address class is `addr_test1w…` / `addr1w…`; an `S`-tagged
  // BASE address (like ORDER_ADDR) would be `addr_test1x…` / `addr1x…`. The `w` after the
  // network tag is the discriminator that proves the intent UTXO is never anchor-enumerated.
  assert.ok(lpIntentAddress(0).startsWith("addr_test1w"));
  assert.ok(lpIntentAddress(1).startsWith("addr1w"));
});
