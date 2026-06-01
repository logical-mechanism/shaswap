//// Spend-path logic for the order and pool validators, factored into the lib so
//// it is unit-testable (Aiken can't import a `validator` module cross-module).
//// The validators are thin wrappers over these.

use aiken/collection/list
use aiken/math
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{Value, ada_policy_id}
use cardano/transaction.{Output, OutputReference, Transaction}
use shaswap/constants.{lp_name, min_liq, nft_name, pool_min_ada, total_lp}
use shaswap/types.{AssetId, PoolDatum}
use shaswap/utils

/// A pool reserve read from the UTXO value: for the ADA side the per-UTXO min-ADA
/// is carved out (overhead, never tradeable/withdrawable liquidity, §5.2.1); for a
/// native-token side it is the raw quantity. When neither side is ADA the pool's
/// lovelace is pure overhead and is not a reserve at all.
pub fn reserve_of(v: Value, a: AssetId) -> Int {
  if a.policy == ada_policy_id {
    assets.lovelace_of(v) - pool_min_ada
  } else {
    utils.asset_qty(v, a)
  }
}

/// Positive part (0 for non-positive). Used to charge the trading fee only on the
/// side the pool *gained* (its net input), never on the side it paid out.
fn pos(x: Int) -> Int {
  if x > 0 {
    x
  } else {
    0
  }
}

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
  // pool identity/params unchanged across the settlement (nft, pair, fee) — the
  // settlement anchor also pins this, but the pool owns its own continuity
  expect out.datum == own.output.datum

  // reserves with the per-UTXO min-ADA carved out of whichever side is ADA
  let res_a_in = reserve_of(own.output.value, d.asset_a)
  let res_b_in = reserve_of(own.output.value, d.asset_b)
  let res_a_out = reserve_of(out.value, d.asset_a)
  let res_b_out = reserve_of(out.value, d.asset_b)

  // Static trading fee φ = fee_num/fee_den (0 ≤ φ < 1), charged Uniswap-v2 style on
  // the net amount that flowed INTO the pool — and ONLY that. The settlement nets
  // orders first (§5.2), so CoW-matched volume never reaches the pool and pays no
  // fee; LPs are paid for the residual liquidity actually consumed. The fee is
  // retained in reserves, so `k` grows and every LP share's redemption value rises
  // (value-derived, §6 — no counter, no treasury). A perfectly-netted batch leaves
  // the pool untouched (in_* = 0) and passes at k unchanged.
  expect d.fee_den > 0
  expect d.fee_num >= 0
  expect d.fee_num < d.fee_den
  let in_a = pos(res_a_out - res_a_in)
  let in_b = pos(res_b_out - res_b_in)
  // effective reserve on each side, ×fee_den: subtract the fee on its net input.
  let eff_a = res_a_out * d.fee_den - d.fee_num * in_a
  let eff_b = res_b_out * d.fee_den - d.fee_num * in_b
  // (eff_a · eff_b) ≥ k_in, scaled by fee_den² to stay integer-exact (no floats).
  eff_a * eff_b >= res_a_in * res_b_in * d.fee_den * d.fee_den
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

  let res_a_in = reserve_of(own.output.value, d.asset_a)
  let res_b_in = reserve_of(own.output.value, d.asset_b)
  let res_a_out = reserve_of(out.value, d.asset_a)
  let res_b_out = reserve_of(out.value, d.asset_b)

  let held_in = utils.asset_qty(own.output.value, lp)
  let held_out = utils.asset_qty(out.value, lp)
  let circ_in = total_lp - held_in
  let circ_out = total_lp - held_out

  // reserves never negative (ADA side also keeps >= pool_min_ada lovelace);
  // held in range
  expect res_a_out >= 0
  expect res_b_out >= 0
  expect held_out >= 0
  expect held_out <= total_lp

  if circ_in == 0 {
    // first deposit: total shares minted == floor(sqrt(reserveA·reserveB))
    expect res_a_out > 0
    expect res_b_out > 0
    expect math.is_sqrt(res_a_out * res_b_out, circ_out)
    // permanently lock min_liq at the unspendable mint-policy address
    expect circ_out > min_liq
    lp_at(tx.outputs, Script(d.nft.policy), lp) >= min_liq
  } else {
    // deposit or withdraw: per-share reserve backing non-decreasing in BOTH
    // assets, and circulating never drops below the permanent lock.
    expect res_a_out * circ_in >= res_a_in * circ_out
    expect res_b_out * circ_in >= res_b_in * circ_out
    circ_out >= min_liq
  }
}
