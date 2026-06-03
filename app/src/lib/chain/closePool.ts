/**
 * Pure helpers to CLOSE a created-but-never-seeded ShaSwap pool: recover its one-shot
 * mint seed (not stored on-chain) and instantiate the seed-applied `pool_mint(seed)`
 * policy so the close tx can burn the NFT + full LP supply. Pure + side-effect-free —
 * the wallet/tx wiring lives in `lib/client/tx.ts`. Mirrors `mint.close` + `spend.pool_close`.
 *
 * Closing is the inverse of creation and ONLY valid for an EMPTY pool (held == total_lp
 * ⟺ circ == 0). After the first deposit the locked MIN_LIQ can never be reassembled, so
 * the pool is immortal (BLUEPRINT §5.1 path c). The creator authorizes teardown by
 * signature (enforced on-chain); these helpers stay clear of the data seam.
 */

import { applyParamsToScript, resolveScriptHash } from "@meshsdk/core";
import { encodeOutputReference, type OutputReference } from "./datums.ts";
import { LP_NAME_HEX, NFT_NAME_HEX, POOL_MINT_COMPILED_CODE } from "./deployment.ts";

const HEX28 = /^[0-9a-fA-F]{56}$/;

/** The per-pool one-shot policy id = hash of the seed-applied `pool_mint` script. */
function policyOf(seed: OutputReference): string {
  return resolveScriptHash(
    applyParamsToScript(
      POOL_MINT_COMPILED_CODE,
      [encodeOutputReference(seed)],
      "Mesh",
    ),
    "V3",
  );
}

/**
 * Recover the pool's one-shot seed from the candidate inputs of its mint tx: the seed is
 * the input whose seed-applied policy id equals the pool's policy id (`nftUnit`'s policy,
 * the first 56 hex). Pure + deterministic. **Throws** if no candidate matches — never
 * guess, so a close is only ever built against the genuine seed.
 */
export function recoverSeed(
  nftUnit: string,
  candidates: OutputReference[],
): OutputReference {
  if (nftUnit.length < 56) throw new Error(`malformed pool NFT unit: ${nftUnit}`);
  const policyId = nftUnit.slice(0, 56).toLowerCase();
  for (const c of candidates) {
    if (policyOf(c) === policyId) return c;
  }
  throw new Error(
    "could not recover the pool's mint seed from its creation tx — cannot close it",
  );
}

/** The close intent: which pool, its recovered seed, and the creator (must sign). */
export interface ClosePoolIntent {
  /** The pool NFT unit (`policyId + nft_name`) — the pool id. */
  nftUnit: string;
  /** The recovered one-shot seed (see `recoverSeed`). */
  seed: OutputReference;
  /** The pool creator's payment key hash (28-byte hex) — must sign the teardown. */
  creatorPkh: string;
}

export interface BuiltClosePool {
  /** The per-pool policy id (NFT/LP) being burned. */
  policyId: string;
  /** The seed-applied V3 mint script (CBOR hex) to inline for the burn. */
  script: string;
  /** The NFT unit being burned (`policyId + nft_name`). */
  nftUnit: string;
  /** The LP unit being burned (`policyId + lp_name`). */
  lpUnit: string;
}

/**
 * Validate + instantiate the seed-applied mint policy for a close. Throws on any
 * malformed intent (non-VK creator, NFT-unit/seed mismatch). The caller burns
 * `{NFT:-1, LP:-total_lp}` under `script` with the `Close` redeemer.
 */
export function buildClosePool(intent: ClosePoolIntent): BuiltClosePool {
  const { nftUnit, seed, creatorPkh } = intent;
  if (!HEX28.test(creatorPkh)) {
    throw new Error("pool creator must be a 28-byte payment key hash (vkey)");
  }
  if (nftUnit.length < 56) throw new Error(`malformed pool NFT unit: ${nftUnit}`);
  const policyId = nftUnit.slice(0, 56).toLowerCase();

  const script = applyParamsToScript(
    POOL_MINT_COMPILED_CODE,
    [encodeOutputReference(seed)],
    "Mesh",
  );
  // The seed MUST reproduce this pool's policy (recoverSeed guarantees it; re-assert so a
  // wrong seed can never build a burn the mint policy would reject on-chain).
  if (resolveScriptHash(script, "V3") !== policyId) {
    throw new Error("seed does not reproduce the pool's mint policy");
  }

  return {
    policyId,
    script,
    nftUnit: policyId + NFT_NAME_HEX,
    lpUnit: policyId + LP_NAME_HEX,
  };
}
