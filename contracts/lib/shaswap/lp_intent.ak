//// LP-intent fulfillment logic (BLUEPRINT §5.1/§5.4 Rev 22,
//// `documentation/spec/lp-intents.md`), factored into the lib so it is unit-testable
//// (Aiken can't import a `validator` module cross-module). The `lp_intent` validator is
//// a thin wrapper over these.
////
//// A fulfillment tx is a **mini-settlement for one LP action**. Two validators run: the
//// UNCHANGED pool `LpAction` (caps over-release/over-mint — protects existing LPs) and
//// `fulfill` here (pins the owner payout exactly — the batcher keeps only the tip).
//// Together they force the batcher to net exactly the tip with no global-conservation
//// pass, exactly as `clearing.ak` does for orders (`check_one`, `is_payout_output`, the
//// value-transform pin, `deadline_ok`).
////
//// **Never folded into a settlement (parameterised by `S`).** `fulfill` asserts the
//// settlement withdraw-0 for `S` is ABSENT, so the pool-spend can only be `LpAction`
//// (PoolSettle requires that withdraw-0; ClosePool burns the NFT). This is what makes
//// the per-share backing (existing-LP protection) actually run: without it a tx could
//// carry a settlement for some `S`-tagged pool P1 AND spend a **non-`S`-tagged** victim
//// pool P2 via `PoolSettle` — which the anchor never enumerates and whose `k`-check does
//// NOT pin held LP — letting a deposit `fulfill` mint unbacked shares (reserves
//// unchanged, held released). The `!withdrawal_present(S)` guard closes that fold. The
//// pool is still bound by NFT (the validator needs `S` but not the pool hash). Mirrors
//// `pool.ak`'s own `LpAction -> !withdrawal_present(S)` mutual-exclusion guard.

use aiken/collection/list
use aiken/interval.{Finite, Interval}
use cardano/address.{Credential}
use cardano/assets.{Value, ada_asset_name, ada_policy_id}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use shaswap/constants.{lp_name, total_lp}
use shaswap/lp_intent_types.{LpDeposit, LpIntentDatum, LpWithdraw}
use shaswap/spend
use shaswap/types.{AssetId, PoolDatum}
use shaswap/utils

/// The tx's finite upper validity bound, if any (None if open-ended). Reimplemented
/// from the (private) `clearing.ak` helper — the frozen module must not change.
fn finite_upper(range: Interval) -> Option<Int> {
  when range.upper_bound.bound_type is {
    Finite(u) -> Some(u)
    _ -> None
  }
}

/// An intent with a deadline can only be fulfilled while the tx is bounded to end no
/// later than the deadline (an open-ended tx can't honor it). Mirror of
/// `clearing.deadline_ok`.
fn deadline_ok(deadline: Option<Int>, tx_upper: Option<Int>) -> Bool {
  when deadline is {
    None -> True
    Some(d) ->
      when tx_upper is {
        Some(u) -> u <= d
        None -> False
      }
  }
}

/// Add a (signed) lovelace delta to a value, preserving every other asset. Mirror of
/// the (private) `clearing.ada_add` — used to remove the tip and (when a pool side is
/// ADA) the traded-ADA from the owner payout, leaving the preserved min-ADA.
fn ada_add(v: Value, delta: Int) -> Value {
  assets.add(v, ada_policy_id, ada_asset_name, delta)
}

/// Require an owner-payout output at `{owner, owner_stake}` (no ref script — audit
/// M-01/L-01) holding EXACTLY `owner_val`. Existence suffices: any extra owner output
/// only costs the batcher, and ledger value conservation together with this pin,
/// `mint == 0`, and the pool's `LpAction` continuity force the batcher to take only the
/// tip (spec: "why the batcher nets exactly the tip"). With one intent per tx (enforced
/// in `fulfill`) the binding is injective with no per-intent NFT and no `BoundDatum`.
fn pin_owner(tx: Transaction, d: LpIntentDatum, owner_val: Value) -> Bool {
  list.any(
    tx.outputs,
    fn(o) {
      utils.is_payout_output(o, d.owner, d.owner_stake) && o.value == owner_val
    },
  )
}

/// `Fulfill`: a batcher fulfils ONE LP intent against its bound pool. Shared preamble
/// (NOT-a-settlement, one-intent-per-tx, `mint == 0`, NFT pool binding, reserves,
/// deadline), then the per-action floor + exact owner pin.
pub fn fulfill(
  tx: Transaction,
  utxo: OutputReference,
  d: LpIntentDatum,
  s: Credential,
) -> Bool {
  // NOT folded into a settlement: a fulfillment is its own self-contained tx. Asserting
  // the settlement withdraw-0 for `s` is ABSENT forces the pool-spend to be `LpAction`
  // (PoolSettle requires that withdraw-0; ClosePool burns the NFT, leaving no pool
  // output), so the pool's per-share backing always runs. This closes the PoolSettle
  // fold that would otherwise mint unbacked shares off a non-`s`-tagged pool the anchor
  // never enumerates (mirrors `pool.ak`'s `LpAction -> !withdrawal_present(S)` guard).
  expect !utils.withdrawal_present(tx, s)

  // exactly one LP-intent input in this tx (our own payment credential). Makes the
  // single owner-output binding injective (v1 = one intent per tx); also lets us read
  // our own intent value below.
  expect Some(own) = list.find(tx.inputs, fn(i) { i.output_reference == utxo })
  let me = own.output.address.payment_credential
  expect [_] = list.filter(
    tx.inputs,
    fn(i) { i.output.address.payment_credential == me },
  )
  let intent_val = own.output.value

  // no minting: the LP the owner burns/receives is MOVED pool<->owner, never conjured
  // (the pool's `LpAction` also enforces this; assert here for self-sufficiency).
  expect assets.is_zero(tx.mint)

  // bind the pool by its unique NFT (supply 1, minted once — only the real pool holds
  // it): exactly one pool input and one pool output.
  expect [pool_in] = list.filter(
    tx.inputs,
    fn(i) { utils.asset_qty(i.output.value, d.pool_nft) == 1 },
  )
  expect [pool_out] = list.filter(
    tx.outputs,
    fn(o) { utils.asset_qty(o.value, d.pool_nft) == 1 },
  )
  // read the pool's REAL pair from its datum (same minimal read as the anchor) and bind
  // the named NFT to the pool's self-declared identity.
  expect InlineDatum(pd) = pool_in.output.datum
  expect pool: PoolDatum = pd
  expect pool.nft == d.pool_nft

  let lp = AssetId { policy: d.pool_nft.policy, name: lp_name }

  // reserves (min-ADA carved out of whichever side is ADA, via the frozen helper).
  let res_a_in = spend.reserve_of(pool_in.output.value, pool.asset_a)
  let res_b_in = spend.reserve_of(pool_in.output.value, pool.asset_b)
  let res_a_out = spend.reserve_of(pool_out.value, pool.asset_a)
  let res_b_out = spend.reserve_of(pool_out.value, pool.asset_b)
  let held_in = utils.asset_qty(pool_in.output.value, lp)
  let held_out = utils.asset_qty(pool_out.value, lp)

  expect deadline_ok(d.deadline, finite_upper(tx.validity_range))
  expect d.tip >= 0

  when d.action is {
    LpWithdraw -> {
      // L LP from the intent must enter the pool's held balance. `L ≥ 1` is a sanity
      // check (a 0-LP withdraw is meaningless); the no-fold guard above — not this — is
      // what prevents a settlement masquerading as a withdraw.
      let l = utils.asset_qty(intent_val, lp)
      expect l >= 1
      expect held_out - held_in == l
      let released_a = res_a_in - res_a_out
      let released_b = res_b_in - res_b_out
      // owner floor (the pool validator separately caps the MAX release via per-share
      // backing — existing-LP protection).
      expect released_a >= d.min_a
      expect released_b >= d.min_b
      expect released_a >= 0
      expect released_b >= 0
      // (Rev 25) exact-proportional pin — close the LP-intent corridor (spec
      // `clearing-price-pin.md` §8, the LP analog of the swap price pin). The released
      // amount must EQUAL the per-share backing (`floor(res_in·l/circ_in)`), which is the
      // MAX the pool's `LpAction` already allows — so the batcher cannot under-release and
      // bank the surplus to remaining LPs. `floor` ≤ exact, so this always satisfies the
      // pool backing check (no liveness loss). `min_a/min_b` become the owner's abort floor.
      let circ_in = total_lp - held_in
      expect released_a == res_a_in * l / circ_in
      expect released_b == res_b_in * l / circ_in
      // pin the pool output's FULL value (mirrors `clearing.ak`'s pool pin): `pool_in`
      // shifted by exactly −released on each reserve and +L held — so the batcher can't
      // sweep the pool's overhead lovelace or any incidental/airdropped asset. This makes
      // the intent path STRICTER than the frozen direct `LpAction` path (which leaves the
      // pool's incidentals unpinned).
      let pool_exp = pool_in.output.value
        |> assets.add(pool.asset_a.policy, pool.asset_a.name, -released_a)
        |> assets.add(pool.asset_b.policy, pool.asset_b.name, -released_b)
        |> assets.add(lp.policy, lp.name, l)
      expect pool_out.value == pool_exp
      // exact owner payout: the released reserves + the leftover (preserved min-ADA, and
      // any incidental asset) ride to the owner; the burned LP leaves; the tip is
      // removed. The value-transform handles the ADA triple-role with no special path
      // (spec §ADA triple-role).
      let owner_val = intent_val
        |> assets.add(lp.policy, lp.name, -l)
        |> assets.add(pool.asset_a.policy, pool.asset_a.name, released_a)
        |> assets.add(pool.asset_b.policy, pool.asset_b.name, released_b)
        |> ada_add(-d.tip)
      pin_owner(tx, d, owner_val)
    }
    LpDeposit -> {
      let circ_in = total_lp - held_in
      // first deposit is NOT intent-fulfillable (the creator seeds directly via the
      // pool's `LpAction` `is_sqrt` path; avoids the MIN_LIQ-lock case here).
      expect circ_in > 0
      // shares released from held (= circ_out − circ_in). `shares ≥ 1` is a sanity check
      // (a 0-share deposit is meaningless); the no-fold guard above prevents a settlement
      // masquerading as a deposit.
      let shares = held_in - held_out
      expect shares >= d.min_shares
      expect shares >= 1
      // deposited assets that entered the pool (a deposit can't pull reserves OUT). The
      // pool validator caps over-minting via per-share backing.
      let dep_a = res_a_out - res_a_in
      let dep_b = res_b_out - res_b_in
      expect dep_a >= 0
      expect dep_b >= 0
      // (Rev 25) exact-proportional pin — close the LP-intent corridor (spec §8). Shares
      // minted == the per-share backing MAX for the deposited amounts:
      // `min(floor(dep_a·circ_in/res_a_in), floor(dep_b·circ_in/res_b_in))` — so the batcher
      // cannot under-credit shares and bank the surplus to remaining LPs. Each term ≤ its
      // real per-share value, so `min` always satisfies the pool backing check. `min_shares`
      // becomes the owner's abort floor.
      let sa = dep_a * circ_in / res_a_in
      let sb = dep_b * circ_in / res_b_in
      expect shares == if sa < sb {
        sa
      } else {
        sb
      }
      // pin the pool output's FULL value (as withdraw, above): `pool_in` shifted by +dep
      // on each reserve and −shares held, nothing else — no overhead/incidental sweep.
      let pool_exp = pool_in.output.value
        |> assets.add(pool.asset_a.policy, pool.asset_a.name, dep_a)
        |> assets.add(pool.asset_b.policy, pool.asset_b.name, dep_b)
        |> assets.add(lp.policy, lp.name, -shares)
      expect pool_out.value == pool_exp
      // exact owner payout: the deposited assets leave the intent (into the pool), the
      // minted shares arrive, the tip is removed; any over-supplied/incidental asset
      // rides back to the owner. ADA triple-role handled by the value-transform.
      let owner_val = intent_val
        |> assets.add(pool.asset_a.policy, pool.asset_a.name, -dep_a)
        |> assets.add(pool.asset_b.policy, pool.asset_b.name, -dep_b)
        |> assets.add(lp.policy, lp.name, shares)
        |> ada_add(-d.tip)
      pin_owner(tx, d, owner_val)
    }
  }
}

/// `ReclaimLp`: owner-signature only (§5.1, non-custodial). Returns the intent (LP
/// tokens for a withdraw, A+B for a deposit) to the owner. Reuses the order-reclaim
/// pattern unchanged. NOTE (§13.11): a withdraw-reclaim returns LP tokens, NOT
/// underlying — converting LP to liquidity mutates shared pool state.
pub fn reclaim(owner: Credential, tx: Transaction) -> Bool {
  spend.order_reclaim(owner, tx)
}
