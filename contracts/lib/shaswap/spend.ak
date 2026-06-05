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

/// Uniswap-v2 fee-on-input swap output (BLUEPRINT §5.2.7, Rev 25): the MAXIMUM
/// `asset_out` the pool may pay for `dx` of `asset_in`, i.e. the amount that lands the
/// reserves exactly on the constant-product `k`-edge.
///
/// `dy = floor( res_out · dx · γ / (res_in · fee_den + dx · γ) )`, `γ = fee_den − fee_num`.
///
/// Integer floor division (no floats, Principle 4); `num ≥ 0` and (for `dx > 0`,
/// `res_in > 0`, `fee_den > 0`) `den > 0`, so `/` is exact floor. Bit-exact with the
/// batcher's `curve.swap_out` and with the `k`-check edge (paying `dy` passes
/// `pool_settle`'s `k`-check, `dy + 1` fails). This is the fair amount the price pin
/// forces the pool to pay **down to** (within the §`pool_settle` dust band).
/// Public so tests and the off-chain↔on-chain parity harness can call the exact curve.
pub fn get_amount_out(
  dx: Int,
  res_in: Int,
  res_out: Int,
  fee_num: Int,
  fee_den: Int,
) -> Int {
  let g = fee_den - fee_num
  res_out * dx * g / ( res_in * fee_den + dx * g )
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
  // the spent input must itself be the NFT-bearing pool (parity with lp_action,
  // which checks this too). The settlement anchor also enforces a single
  // NFT-bearing pool input, but the pool owns its own continuity (§5.4).
  expect utils.asset_qty(own.output.value, d.nft) == 1
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
  // reserves never negative (the ADA side keeps >= pool_min_ada lovelace). Parity
  // with lp_action; the k-check below would also reject a negative reserve, but
  // make it an explicit invariant rather than emergent (cf. L-02).
  expect res_a_out >= 0
  expect res_b_out >= 0

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
  let net_a = res_a_out - res_a_in
  let net_b = res_b_out - res_b_in
  let in_a = pos(net_a)
  let in_b = pos(net_b)
  // effective reserve on each side, ×fee_den: subtract the fee on its net input.
  let eff_a = res_a_out * d.fee_den - d.fee_num * in_a
  let eff_b = res_b_out * d.fee_den - d.fee_num * in_b
  // (eff_a · eff_b) ≥ k_in, scaled by fee_den² to stay integer-exact (no floats). This
  // caps the price interval from ABOVE — the pool can never pay out so much that k drops.
  let k_ok = eff_a * eff_b >= res_a_in * res_b_in * d.fee_den * d.fee_den

  // (Rev 25) Two-sided price pin — close the floor→fair corridor (§5.2.7,
  // `spec/clearing-price-pin.md`). The `k`-check alone is one-sided: underpaying a trader
  // RAISES k, so it never blocks a low price. Here we add the missing LOWER edge — the pool
  // must release the FULL constant-product curve amount for the net residual it absorbed.
  // Because the residual trades at the single uniform price (`net_b = −net_a·p`, clearing.ak),
  // pinning the pool's payout to the curve forces `p` to the fair curve-execution price for
  // EVERY order in the batch (recovers the §5.2.4 best-response for directional flow).
  //
  // Dust band: the anchor floors each order's `received = floor(f·num/den)`, so the
  // aggregate payout lands up to `n_orders` sub-units below the single-floored
  // `get_amount_out`. `eps = n_orders` (S-tagged inputs minus the pool) is an ABSOLUTE,
  // batch-size-derived bound — never a fraction of k — so any residual underpayment is
  // ≤ n_orders sub-units of the paid asset (vs the unbounded corridor it closes). A solver
  // can always pick `p = get_amount_out(net_a)/net_a` and clear within the band (liveness).
  let n_orders =
    list.length(list.filter(tx.inputs, fn(i) { utils.is_tagged(i.output, s) })) - 1
  let pin_ok =
    if net_a > 0 && net_b < 0 {
      // pool took asset_a, paid asset_b: paid-out ≥ fair − dust
      -net_b >= get_amount_out(net_a, res_a_in, res_b_in, d.fee_num, d.fee_den) - n_orders
    } else if net_b > 0 && net_a < 0 {
      // pool took asset_b, paid asset_a (symmetric)
      -net_a >= get_amount_out(net_b, res_b_in, res_a_in, d.fee_num, d.fee_den) - n_orders
    } else {
      // No residual paid out: a perfectly-netted batch (net = 0 — the documented
      // trader↔trader residue, spec §5) or a donation (both sides ≥ 0, only raises k —
      // `k_ok` allows it). A both-negative drain (pool pays both with no input) is rejected
      // by `k_ok`. Nothing to pin in these cases.
      True
    }
  k_ok? && pin_ok?
}

/// Pool `ClosePool`: tear down a created-but-never-seeded pool. Only valid when
/// the pool still holds the ENTIRE LP supply (`held == total_lp` ⟺ no LP is
/// circulating, so nobody can be robbed), the **creator signs** (so a stranger can't
/// grief the pool or pocket its seed in the pre-deposit window — §13.10), and the tx
/// burns the NFT + full LP supply. After a first deposit `held < total_lp` and the
/// locked MIN_LIQ can never be reassembled, so this can never close a live pool.
pub fn pool_close(tx: Transaction, utxo: OutputReference, d: PoolDatum) -> Bool {
  expect Some(own) = list.find(tx.inputs, fn(i) { i.output_reference == utxo })
  let p = d.nft.policy
  let lp = AssetId { policy: p, name: lp_name }
  expect utils.asset_qty(own.output.value, lp) == total_lp
  // only the creator may tear down (and thereby redirect the seed value);
  // signature-based, so `creator` must be a VK credential (§5.1).
  expect VerificationKey(vkh) = d.creator
  expect list.has(tx.extra_signatories, vkh)
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
  // pool identity/params unchanged (nft, token, fee); no attached reference script
  // (audit L-01 — this is the standalone path, not pinned by the settlement anchor)
  expect out.datum == own.output.datum
  expect out.reference_script == None

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

  // (M-01/L-02) pin the pool output's FULL value: `own` shifted by exactly the
  // reserve delta on each side and the held-LP delta — and NOTHING else. This is the
  // same discipline the settlement anchor (`clearing.ak`) and the `lp_intent` path
  // already use; adopting it here makes all three pool-mutation paths uniform.
  //  - M-01: no foreign-policy dust can ride into the shared pool output, so an
  //    attacker can't bloat it toward `maxValueSize` via no-op `LpAction`s.
  //  - L-02: on a token/token pool neither reserve delta touches lovelace, so the
  //    pin holds the pool's overhead lovelace fixed — closing the one-time skim.
  // The reserve/LP components match `out` by construction (they're read from it), so
  // the teeth are on the NFT (kept), incidentals (frozen), and the token/token
  // overhead lovelace.
  let pool_exp = own.output.value
    |> assets.add(d.asset_a.policy, d.asset_a.name, res_a_out - res_a_in)
    |> assets.add(d.asset_b.policy, d.asset_b.name, res_b_out - res_b_in)
    |> assets.add(lp.policy, lp.name, held_out - held_in)
  expect out.value == pool_exp

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
