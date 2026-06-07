//// Pool creation/closure mint logic (BLUEPRINT §5.1 identity, §6 LP model),
//// factored into the lib so it is unit-testable. One-shot per pool: the policy
//// is parameterised by a seed OutputReference, so its hash — and therefore the
//// pool NFT — is unique, and `Create` can fire only once (the seed is consumed).

use aiken/collection/list
use cardano/address.{VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use shaswap/constants.{lp_name, nft_name, pool_min_ada, total_lp}
use shaswap/types.{PoolDatum}

/// Create: consume the seed, mint exactly {NFT: 1, LP: total_lp} under this
/// policy (and nothing else), require both to land together in one output — the
/// pool UTXO — so a creator can't siphon LP to themselves, and **validate that
/// output's `PoolDatum` is well-formed** (fail-fast: a misconfigured pool can't even
/// be created, rather than silently bricking later — §13.10).
pub fn create(
  seed: OutputReference,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })
  // only the NFT and LP are minted under this policy (no stray assets)
  expect
    list.length(assets.flatten(assets.restricted_to(tx.mint, [policy_id]))) == 2
  expect assets.quantity_of(tx.mint, policy_id, nft_name) == 1
  expect assets.quantity_of(tx.mint, policy_id, lp_name) == total_lp
  // NFT + full LP supply land together in one output (the pool)
  expect Some(pool) = list.find(
    tx.outputs,
    fn(o) {
      assets.quantity_of(o.value, policy_id, nft_name) == 1 && assets.quantity_of(
        o.value,
        policy_id,
        lp_name,
      ) == total_lp
    },
  )
  // the pool output must carry a well-formed PoolDatum:
  expect InlineDatum(pd) = pool.datum
  expect d: PoolDatum = pd
  // identity: the datum's NFT is THIS policy's canonical NFT
  expect d.nft.policy == policy_id
  expect d.nft.name == nft_name
  // a real, non-degenerate EXTERNAL pair: the two sides differ, and neither is the
  // pool's own NFT/LP (which live under `policy_id`) — else `reserve_of` would read
  // the pool's own tokens as reserves.
  expect d.asset_a != d.asset_b
  expect d.asset_a.policy != policy_id
  expect d.asset_b.policy != policy_id
  // static fee in range 0 <= phi = fee_num/fee_den < 1
  expect d.fee_den > 0
  expect d.fee_num >= 0
  expect d.fee_num < d.fee_den
  // (I-03) `creator` authorizes ClosePool by SIGNATURE, so it must be a VK
  // credential — assert it at create (the only fail-fast gate) rather than let a
  // Script-credential creator silently brick the pre-seed teardown path.
  expect VerificationKey(_) = d.creator
  // (L-03) the pool must hold at least the per-UTXO min-ADA overhead that
  // `reserve_of` carves out — otherwise its ADA reserve would be negative and the
  // first deposit / every settlement against it would be infeasible (self-brick).
  // This is the on-chain half of the placement invariant; the OFF-CHAIN builder is
  // still responsible for placing the pool at the `pool(S)` address tagged `S` (the
  // mint policy is parameterised only by the seed and so cannot see `S` — but the
  // one-shot NFT + post-creation address continuity make a mis-placement a creator
  // self-grief, never a theft of others' funds — audit L-03).
  expect assets.lovelace_of(pool.value) >= pool_min_ada
  True
}

/// Close: burn-only — no positive quantity may be minted under this policy.
///
/// (I-03) This gates only the SIGN of the policy's mint (every triple `q ≤ 0`); it is
/// deliberately decoupled from the pool spend. The dangerous burns — the pool's *held*
/// NFT/LP — are impossible without spending the pool input, which routes through
/// `pool.ClosePool` (held == total_lp + creator signature + full NFT/LP burn). The only
/// thing this branch lets a holder do standalone is burn their OWN *circulating* LP:
/// a self-forfeiture (reserves unchanged, fewer real claims, other LPs unharmed). So it
/// is self-harm-only, never a theft path — pinned by `close_burns_circulating_lp`.
pub fn close(policy_id: PolicyId, tx: Transaction) -> Bool {
  list.all(
    assets.flatten(assets.restricted_to(tx.mint, [policy_id])),
    fn(triple) {
      let (_p, _n, q) = triple
      q <= 0
    },
  )
}
