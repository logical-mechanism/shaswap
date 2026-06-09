/**
 * Derive the `lp_intent` validator's script hash + its ENTERPRISE address (BLUEPRINT
 * §5.1/§5.4 Rev 22).
 *
 * The `lp_intent` validator is parameterised by the settlement credential `S` (like the
 * order/pool validators): apply `Credential::Script(SETTLEMENT_HASH)` to the committed,
 * unapplied `LP_INTENT_COMPILED_CODE` then hash it. The intent UTXO lives at the
 * **enterprise** form of that hash — payment = the `lp_intent` script hash, stake = **None**
 * — NEVER `S`-tagged, so the settlement anchor (which enumerates only `stake == Some(S)`)
 * can never pull an intent into a settlement (a hard invariant; the spec's no-fold guard is
 * a second, on-chain line of defence). Contrast the order/pool addresses, which ARE `S`-tagged
 * base addresses.
 *
 * Derived (not a committed literal) so the hash/address auto-track whatever `S` this
 * deployment declares — at any future redeploy, bumping `SETTLEMENT_HASH` re-derives the
 * correct values with no other edit. `applyParamsToScript`/`resolveScriptHash` are pure (no
 * provider), mirroring `buildCreatePool`'s per-seed policy derivation; this module is kept
 * separate from the pure-data `deployment.ts` because it pulls in `@meshsdk/core`.
 *
 * `lpIntentScript.test.ts` pins the derived values to goldens so a hash/address drift fails
 * loudly — the LP analogue of `address.test.ts`.
 */

import { applyParamsToScript, resolveScriptHash } from "@meshsdk/core";
import type { NetworkId } from "../config.ts";
import { encodeCredential } from "./datums.ts";
import { deriveEnterpriseScriptAddress } from "./address.ts";
import { LP_INTENT_COMPILED_CODE, SETTLEMENT_HASH } from "./deployment.ts";

let cachedHash: string | undefined;
const cachedAddr = new Map<NetworkId, string>();

/**
 * The S-applied `lp_intent` script hash (the intent address's payment credential).
 * Memoised — `applyParamsToScript` is non-trivial and the inputs are module constants.
 */
export function lpIntentScriptHash(): string {
  if (cachedHash) return cachedHash;
  const sCred = encodeCredential({ kind: "script", hash: SETTLEMENT_HASH });
  const script = applyParamsToScript(LP_INTENT_COMPILED_CODE, [sCred], "Mesh");
  cachedHash = resolveScriptHash(script, "V3");
  return cachedHash;
}

/**
 * The `lp_intent` ENTERPRISE address (stake = None) for a network — where intents are posted
 * and discovered. Memoised per network.
 */
export function lpIntentAddress(networkId: NetworkId): string {
  const hit = cachedAddr.get(networkId);
  if (hit) return hit;
  const addr = deriveEnterpriseScriptAddress(lpIntentScriptHash(), networkId);
  cachedAddr.set(networkId, addr);
  return addr;
}
