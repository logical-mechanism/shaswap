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

// Golden values computed from the CURRENT deployment `S` (preprod a57de7a9…). These move at
// the Phase-4 redeploy exactly as ORDER_ADDR/POOL_ADDR do — the pin is a drift guard, not a
// permanent identity.
const GOLDEN_HASH = "99713f9230e0ef80d3f1d2c8fb8d25ba93d5d70c8d76eb2ffd8a580b";
const GOLDEN_PREPROD =
  "addr_test1wzvhz0ujxrswlqxn78fv37udykaf84whpjxhd6e0lk99szc69ex52";
const GOLDEN_MAINNET =
  "addr1wxvhz0ujxrswlqxn78fv37udykaf84whpjxhd6e0lk99szcpdd6m0";

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
