//// Spend-path logic for the order and pool validators, factored into the lib so
//// it is unit-testable (Aiken can't import a `validator` module cross-module).
//// The validators are thin wrappers over these.

use aiken/collection/list
use cardano/address.{Credential, VerificationKey}
use cardano/assets
use cardano/transaction.{OutputReference, Transaction}
use shaswap/types.{PoolDatum}
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
  let k_in = assets.lovelace_of(own.output.value) * utils.asset_qty(
    own.output.value,
    d.token,
  )
  let k_out = assets.lovelace_of(out.value) * utils.asset_qty(
    out.value,
    d.token,
  )
  k_out >= k_in
}
