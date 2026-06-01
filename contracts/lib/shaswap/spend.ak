//// Spend-path logic for the order and pool validators, factored into the lib so
//// it is unit-testable (Aiken can't import a `validator` module cross-module).
//// The validators are thin wrappers over these.

use aiken/collection/list
use aiken/math
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{Output, OutputReference, Transaction}
use shaswap/constants.{lp_name, min_liq, nft_name, pool_min_ada, total_lp}
use shaswap/types.{AssetId, PoolDatum}
use shaswap/utils

/// Order `Settle`: defer to settlement, but self-enforce that our own input is
/// tagged with `s` so we can only ride in a settlement that will enumerate us
/// (closes the input-smuggle path, §8).
pub fn order_settle(
  tx: Transaction,
  utxo: OutputReference,
  s: Credential,
) -> Bool {
  expect Some(own) = list.find(tx.inputs, fn(i) { i.output_reference == utxo })
  utils.is_tagged(own.output, s)? && utils.withdrawal_present(tx, s)?
}

/// Order `Reclaim`: owner signature alone (§5.1, non-custodial).
pub fn order_reclaim(owner: Credential, tx: Transaction) -> Bool {
  expect VerificationKey(vkh) = owner
  list.has(tx.extra_signatories, vkh)
}

/// Pool `PoolSettle`: defer batch checks to settlement, but own the curve
/// invariant `k_after >= k_before` from actual reserves (§5.4 split). The
/// recreated pool is the output at our address carrying our NFT (continuity).
pub fn pool_settle(
  tx: Transaction,
  utxo: OutputReference,
  d: PoolDatum,
  s: Credential,
) -> Bool {
  expect utils.withdrawal_present(tx, s)
  expect Some(own) = list.find(tx.inputs, fn(i) { i.output_reference == utxo })
  expect [out] = list.filter(
    tx.outputs,
    fn(o) {
      o.address == own.output.address && utils.asset_qty(o.value, d.nft) == 1
    },
  )
  // reserves with the per-UTXO min-ADA carved out (consistent with the LP path)
  let k_in = ( assets.lovelace_of(own.output.value) - pool_min_ada ) * utils.asset_qty(
    own.output.value,
    d.token,
  )
  let k_out = ( assets.lovelace_of(out.value) - pool_min_ada ) * utils.asset_qty(
    out.value,
    d.token,
  )
  k_out >= k_in
}

/// Pool `ClosePool`: tear down a created-but-never-seeded pool. Only valid when
/// the pool still holds the ENTIRE LP supply (`held == total_lp` ⟺ no LP is
/// circulating, so nobody can be robbed), and the tx burns the NFT + full LP
/// supply. After a first deposit `held < total_lp` and the locked MIN_LIQ can
/// never be reassembled, so this can never close a live pool.
pub fn pool_close(tx: Transaction, utxo: OutputReference, d: PoolDatum) -> Bool {
  expect Some(own) = list.find(tx.inputs, fn(i) { i.output_reference == utxo })
  let p = d.nft.policy
  let lp = AssetId { policy: p, name: lp_name }
  expect utils.asset_qty(own.output.value, lp) == total_lp
  and {
    assets.quantity_of(tx.mint, p, nft_name) == -1,
    assets.quantity_of(tx.mint, p, lp_name) == -total_lp,
  }
}

/// Sum of LP tokens at outputs locked by the given (payment) credential.
fn lp_at(outputs: List<Output>, cred: Credential, lp: AssetId) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if o.address.payment_credential == cred {
        acc + utils.asset_qty(o.value, lp)
      } else {
        acc
      }
    },
  )
}

/// LP deposit/withdraw (BLUEPRINT §6, Rev 7) — a standalone tx (no settlement).
/// Fully value-derived: reserves from the pool value (min-ADA carved out), LP
/// circulating supply = `total_lp − held`. Enforces per-share reserve backing
/// non-decreasing in both assets (protects existing LPs in both directions), the
/// first-deposit `is_sqrt` rule with a permanently-locked `min_liq`, NFT + datum
/// continuity, and no LP mint/burn (LP only moves pool<->user).
pub fn lp_action(tx: Transaction, utxo: OutputReference, d: PoolDatum) -> Bool {
  // no minting/burning in a deposit/withdraw — LP just moves pool<->user
  expect assets.is_zero(tx.mint)

  // the pool input being spent, and the recreated pool output (NFT continuity)
  expect Some(own) = list.find(tx.inputs, fn(i) { i.output_reference == utxo })
  let in_addr = own.output.address
  expect utils.asset_qty(own.output.value, d.nft) == 1
  expect [out] = list.filter(
    tx.outputs,
    fn(o) { o.address == in_addr && utils.asset_qty(o.value, d.nft) == 1 },
  )
  // pool identity/params unchanged (nft, token, fee)
  expect out.datum == own.output.datum

  let lp = AssetId { policy: d.nft.policy, name: lp_name }

  let res_ada_in = assets.lovelace_of(own.output.value) - pool_min_ada
  let res_tok_in = utils.asset_qty(own.output.value, d.token)
  let res_ada_out = assets.lovelace_of(out.value) - pool_min_ada
  let res_tok_out = utils.asset_qty(out.value, d.token)

  let held_in = utils.asset_qty(own.output.value, lp)
  let held_out = utils.asset_qty(out.value, lp)
  let circ_in = total_lp - held_in
  let circ_out = total_lp - held_out

  // pool retains >= pool_min_ada lovelace; reserves never negative; held in range
  expect res_ada_out >= 0
  expect res_tok_out >= 0
  expect held_out >= 0
  expect held_out <= total_lp

  if circ_in == 0 {
    // first deposit: total shares minted == floor(sqrt(reserveA·reserveB))
    expect res_ada_out > 0
    expect res_tok_out > 0
    expect math.is_sqrt(res_ada_out * res_tok_out, circ_out)
    // permanently lock min_liq at the unspendable mint-policy address
    expect circ_out > min_liq
    lp_at(tx.outputs, Script(d.nft.policy), lp) >= min_liq
  } else {
    // deposit or withdraw: per-share reserve backing non-decreasing in BOTH
    // assets, and circulating never drops below the permanent lock.
    expect res_ada_out * circ_in >= res_ada_in * circ_out
    expect res_tok_out * circ_in >= res_tok_in * circ_out
    circ_out >= min_liq
  }
}
