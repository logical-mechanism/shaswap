/**
 * Low-level Cardano address helpers for ShaSwap's stake-tagged (`S`) addresses.
 *
 * The order/pool UTXOs live at *base* addresses whose payment credential is the
 * order/pool **script** hash and whose stake credential is the settlement script
 * hash `S` (BLUEPRINT §5.4). MeshJS's `scriptHashToBech32` only builds a *key*-hash
 * stake credential, which yields the wrong address type — so we construct the base
 * address from two **script** credentials via the cardano-sdk primitives that
 * `@meshsdk/core-cst` re-exports.
 *
 * `deriveBaseAddress` is the single source of the order/pool addresses; the committed
 * constants in `deployment.ts` are pinned to it by `address.test.ts`.
 */

import { Cardano, Crypto } from "@meshsdk/core-cst";
import type { NetworkId } from "@/lib/config";

function scriptCredential(hashHex: string): Cardano.Credential {
  return {
    type: Cardano.CredentialType.ScriptHash,
    hash: Crypto.Hash28ByteBase16(hashHex),
  };
}

/**
 * Build the bech32 base address for `(payment = paymentScriptHash, stake =
 * stakeScriptHash)`, both **script** credentials — i.e. ShaSwap's `S`-tagged
 * order/pool addresses.
 */
export function deriveBaseAddress(
  paymentScriptHash: string,
  stakeScriptHash: string,
  networkId: NetworkId,
): string {
  return Cardano.BaseAddress.fromCredentials(
    networkId as unknown as Cardano.NetworkId,
    scriptCredential(paymentScriptHash),
    scriptCredential(stakeScriptHash),
  )
    .toAddress()
    .toBech32();
}

/**
 * Build the bech32 **enterprise** address for a single **script** payment credential
 * (no stake part). This is `Script(scriptHash)` as an address — used for the LP
 * first-deposit `min_liq` lock at `Script(nft.policy)` (the pool's own mint policy is
 * an unspendable Plutus script, so LP parked there can never be reassembled, bounding
 * the first-depositor donation attack — BLUEPRINT §6).
 */
export function deriveEnterpriseScriptAddress(
  paymentScriptHash: string,
  networkId: NetworkId,
): string {
  return Cardano.EnterpriseAddress.fromCredentials(
    networkId as unknown as Cardano.NetworkId,
    scriptCredential(paymentScriptHash),
  )
    .toAddress()
    .toBech32();
}
