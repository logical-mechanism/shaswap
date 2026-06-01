//// Pool creation/closure mint logic (BLUEPRINT §5.1 identity, §6 LP model),
//// factored into the lib so it is unit-testable. One-shot per pool: the policy
//// is parameterised by a seed OutputReference, so its hash — and therefore the
//// pool NFT — is unique, and `Create` can fire only once (the seed is consumed).

use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use shaswap/constants.{lp_name, nft_name, total_lp}
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
  expect Some(pool) =
    list.find(
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
  d.fee_num < d.fee_den
}

/// Close: burn-only — no positive quantity may be minted under this policy.
pub fn close(policy_id: PolicyId, tx: Transaction) -> Bool {
  list.all(
    assets.flatten(assets.restricted_to(tx.mint, [policy_id])),
    fn(triple) {
      let (_p, _n, q) = triple
      q <= 0
    },
  )
}
