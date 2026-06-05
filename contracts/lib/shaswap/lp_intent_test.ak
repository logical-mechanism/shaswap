//// Tests for the LP-intent fulfillment path (`lp_intent.fulfill` / `.reclaim`,
//// BLUEPRINT §5.1/§5.4 Rev 22, spec/lp-intents.md) — exhaustive and negatives-heavy,
//// because `fulfill` is NEW value-protecting code outside the battle-tested settlement
//// anchor's blanket pinning. Most realistic cases run BOTH validators that fire on a
//// real fulfillment tx: the UNCHANGED pool `LpAction` (`spend.lp_action`, caps
//// over-release/over-mint) and `lp_intent.fulfill` (pins the owner payout). A few
//// fulfill-only checks call `fulfill` in isolation.

use aiken/collection/list
use aiken/fuzz
use aiken/interval.{Interval}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use shaswap/constants.{lp_name, pool_min_ada, total_lp}
use shaswap/lp_intent
use shaswap/lp_intent_types.{
  LpDeposit, LpIntentDatum, LpWithdraw, lp_intent_min_ada,
}
use shaswap/spend
use shaswap/types.{AssetId, PoolDatum}

// ---- fixtures -------------------------------------------------------------

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const p_hash = #"9999999999999999999999999999999999999999999999999999999c"

// the lp_intent validator's payment credential (its own hash).
const li_hash = #"1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c"

const owner_vkh = #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

const stake_vkh = #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"

const some_script = #"abababababababababababababababababababababababababababab"

const creator_vkh = #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

const nft_policy = #"4444444444444444444444444444444444444444444444444444444e"

const nft = AssetId { policy: nft_policy, name: #"4e4654" }

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

const tokb =
  AssetId {
    policy: #"888888888888888888888888888888888888888888888888888888ff",
    name: #"42",
  }

const ada = AssetId { policy: #"", name: #"" }

const junk =
  AssetId {
    policy: #"7777777777777777777777777777777777777777777777777777777f",
    name: #"6a6e6b",
  }

const intent_txid =
  #"1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a"

const intent_txid2 =
  #"2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b"

const pool_txid =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

const tip = 1_000_000

fn owner() -> Credential {
  VerificationKey(owner_vkh)
}

/// The settlement credential `S` (the lp_intent validator's parameter).
fn s() -> Credential {
  Script(s_hash)
}

fn intent_ref() -> OutputReference {
  OutputReference { transaction_id: intent_txid, output_index: 0 }
}

fn intent_ref2() -> OutputReference {
  OutputReference { transaction_id: intent_txid2, output_index: 0 }
}

fn pool_ref() -> OutputReference {
  OutputReference { transaction_id: pool_txid, output_index: 0 }
}

fn pool_addr() -> Address {
  Address {
    payment_credential: Script(p_hash),
    stake_credential: Some(Inline(Script(s_hash))),
  }
}

fn intent_addr() -> Address {
  // payment = the lp_intent validator; stake = None (enterprise) — deliberately NOT S,
  // so the settlement anchor never enumerates it (§5.4).
  Address { payment_credential: Script(li_hash), stake_credential: None }
}

// ---- ADA-paired pool (asset_a = tok, asset_b = ADA) -----------------------

fn pool_datum() -> PoolDatum {
  PoolDatum {
    nft,
    asset_a: tok,
    asset_b: ada,
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(creator_vkh),
  }
}

fn pool_val(res_tok: Int, res_ada: Int, held: Int) -> Value {
  assets.from_lovelace(res_ada + pool_min_ada)
    |> assets.add(tok.policy, tok.name, res_tok)
    |> assets.add(nft.policy, nft.name, 1)
    |> assets.add(nft.policy, lp_name, held)
}

fn pool_in(res_tok: Int, res_ada: Int, held: Int) -> Input {
  Input {
    output_reference: pool_ref(),
    output: Output {
      address: pool_addr(),
      value: pool_val(res_tok, res_ada, held),
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
}

fn pool_out(res_tok: Int, res_ada: Int, held: Int) -> Output {
  Output {
    address: pool_addr(),
    value: pool_val(res_tok, res_ada, held),
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

// ---- intents + payouts ----------------------------------------------------

fn wd_datum(min_a: Int, min_b: Int, dl: Option<Int>) -> LpIntentDatum {
  LpIntentDatum {
    owner: owner(),
    owner_stake: None,
    pool_nft: nft,
    action: LpWithdraw,
    min_a,
    min_b,
    min_shares: 0,
    tip,
    deadline: dl,
  }
}

fn dep_datum(min_shares: Int, dl: Option<Int>) -> LpIntentDatum {
  LpIntentDatum {
    owner: owner(),
    owner_stake: None,
    pool_nft: nft,
    action: LpDeposit,
    min_a: 0,
    min_b: 0,
    min_shares,
    tip,
    deadline: dl,
  }
}

fn intent_at(ref: OutputReference, value: Value, d: LpIntentDatum) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: intent_addr(),
      value,
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

// owner payout at {owner, owner_stake}, no ref script, holding `value`.
fn payout(value: Value, owner_stake: Option<Credential>) -> Output {
  let stake = when owner_stake is {
    Some(c) -> Some(Inline(c))
    None -> None
  }
  Output {
    address: Address { payment_credential: owner(), stake_credential: stake },
    value,
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

// ---- harnesses ------------------------------------------------------------

fn fx(intent: Input, pin: Input, outputs: List<Output>) -> Transaction {
  Transaction { ..transaction.placeholder, inputs: [intent, pin], outputs }
}

// both validators that fire on a real fulfillment tx must pass.
fn both(tx: Transaction, d: LpIntentDatum) -> Bool {
  lp_intent.fulfill(tx, intent_ref(), d, s()) && spend.lp_action(
    tx,
    pool_ref(),
    pool_datum(),
  )
}

// fulfill in isolation (for checks where the pool-spend would diverge).
fn only_fulfill(tx: Transaction, d: LpIntentDatum) -> Bool {
  lp_intent.fulfill(tx, intent_ref(), d, s())
}

// ===========================================================================
// WITHDRAW
// ===========================================================================
// Pool: 200M tok / 100M ADA, circulating 1_000_000. A 10% withdraw burns
// L = 100_000 LP and releases 20M tok + 10M ADA.

fn wd_intent(l: Int) -> Input {
  intent_at(
    intent_ref(),
    assets.from_lovelace(lp_intent_min_ada + tip)
      |> assets.add(nft.policy, lp_name, l),
    wd_datum(0, 0, None),
  )
}

// happy: released 20M tok + 10M ADA, owner gets them + preserved 2M min, tip removed.
test withdraw_ok() {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  )
  both(tx, wd_datum(19_000_000, 9_000_000, None))
}

// released_a below the owner floor (min_a set above what was released): rejected.
test withdraw_below_floor() fail {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  )
  both(tx, wd_datum(21_000_000, 9_000_000, None))
}

// batcher under-pays the owner (pays 19M tok, keeps 1M): the exact pin finds no
// matching owner output → rejected.
test withdraw_owner_underpaid() fail {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 19_000_000),
        None,
      ),
    ],
  )
  both(tx, wd_datum(0, 0, None))
}

// batcher skims the tip twice (owner short 1M ADA): rejected by the exact pin.
test withdraw_tip_overcollected() fail {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 9_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  )
  both(tx, wd_datum(0, 0, None))
}

// over-release beyond per-share backing (take 25M tok for the same 100k burn): the
// owner pin passes (owner is over-paid), but the POOL validator rejects.
test withdraw_over_release() fail {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(175_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 25_000_000),
        None,
      ),
    ],
  )
  both(tx, wd_datum(0, 0, None))
}

// the burned LP does not fully enter the pool's held balance (held grows by 90k, not
// the 100k the intent holds — batcher pocketed 10k LP): rejected by `held_out − held_in == L`.
test withdraw_lp_pocketed() fail {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 910_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  )
  only_fulfill(tx, wd_datum(0, 0, None))
}

// the intent holds zero LP (L < 1): a "withdraw" of nothing is rejected (strict held
// change — also what forbids a settlement masquerading as a withdraw).
test withdraw_zero_lp() fail {
  let tx = fx(
    intent_at(
      intent_ref(),
      assets.from_lovelace(lp_intent_min_ada + tip),
      wd_datum(0, 0, None),
    ),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(200_000_000, 100_000_000, total_lp - 1_000_000),
      payout(assets.from_lovelace(lp_intent_min_ada), None),
    ],
  )
  only_fulfill(tx, wd_datum(0, 0, None))
}

// datum names a pool NFT that no input carries: no pool bound → rejected.
test withdraw_wrong_pool_nft() fail {
  let other = AssetId { policy: nft_policy, name: #"4f4f4f" }
  let tx = fx(
    intent_at(
      intent_ref(),
      assets.from_lovelace(lp_intent_min_ada + tip)
        |> assets.add(nft.policy, lp_name, 100_000),
      LpIntentDatum { ..wd_datum(0, 0, None), pool_nft: other },
    ),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  )
  only_fulfill(tx, LpIntentDatum { ..wd_datum(0, 0, None), pool_nft: other })
}

// payout at the wrong address (a stake credential the owner never chose): the
// `is_payout_output` pin (M-01) rejects it.
test withdraw_payout_stake_hijack() fail {
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        Some(VerificationKey(stake_vkh)),
      ),
    ],
  )
  both(tx, wd_datum(0, 0, None))
}

// payout carrying an attached reference script (L-01 min-ADA bloat): rejected.
test withdraw_payout_ref_script() fail {
  let bad = Output {
    address: Address { payment_credential: owner(), stake_credential: None },
    value: assets.from_lovelace(lp_intent_min_ada + 10_000_000)
      |> assets.add(tok.policy, tok.name, 20_000_000),
    datum: transaction.NoDatum,
    reference_script: Some(some_script),
  }
  let tx = fx(
    wd_intent(100_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [pool_out(180_000_000, 90_000_000, total_lp - 900_000), bad],
  )
  both(tx, wd_datum(0, 0, None))
}

// deadline honored / expired (reuses interval.before like clearing_test).
fn wd_tx_range(range: Interval) -> Transaction {
  Transaction {
    ..fx(
      wd_intent(100_000),
      pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
      [
        pool_out(180_000_000, 90_000_000, total_lp - 900_000),
        payout(
          assets.from_lovelace(lp_intent_min_ada + 10_000_000)
            |> assets.add(tok.policy, tok.name, 20_000_000),
          None,
        ),
      ],
    ),
    validity_range: range,
  }
}

test withdraw_deadline_within() {
  only_fulfill(wd_tx_range(interval.before(900)), wd_datum(0, 0, Some(1000)))
}

test withdraw_deadline_expired() fail {
  only_fulfill(wd_tx_range(interval.before(1500)), wd_datum(0, 0, Some(1000)))
}

test withdraw_deadline_open_tx() fail {
  only_fulfill(wd_tx_range(interval.everything), wd_datum(0, 0, Some(1000)))
}

// two LP-intent inputs in one tx (v1 = one per tx): the one-input guard rejects it.
test withdraw_two_intents() fail {
  let i1 = wd_intent(100_000)
  let i2 = intent_at(
    intent_ref2(),
    assets.from_lovelace(lp_intent_min_ada + tip)
      |> assets.add(nft.policy, lp_name, 100_000),
    wd_datum(0, 0, None),
  )
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [i1, i2, pool_in(200_000_000, 100_000_000, total_lp - 1_000_000)],
    outputs: [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  }
  lp_intent.fulfill(tx, intent_ref(), wd_datum(0, 0, None), s())
}

// base-address payout (owner pins a stake credential): honored when paid there.
test withdraw_base_payout_ok() {
  let stake = VerificationKey(stake_vkh)
  let d = LpIntentDatum { ..wd_datum(0, 0, None), owner_stake: Some(stake) }
  let tx = fx(
    intent_at(
      intent_ref(),
      assets.from_lovelace(lp_intent_min_ada + tip)
        |> assets.add(nft.policy, lp_name, 100_000),
      d,
    ),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        Some(stake),
      ),
    ],
  )
  lp_intent.fulfill(tx, intent_ref(), d, s()) && spend.lp_action(
    tx,
    pool_ref(),
    pool_datum(),
  )
}

// ===========================================================================
// DEPOSIT
// ===========================================================================
// Pool: 200M tok / 100M ADA, circulating 1_000_000. A 10% deposit adds 20M tok +
// 10M ADA and mints 100_000 shares. (ADA side -> the intent's lovelace carries
// traded-ADA + tip + min: the triple-role.)

fn dep_intent(da_tok: Int, db_ada: Int) -> Input {
  intent_at(
    intent_ref(),
    assets.from_lovelace(db_ada + tip + lp_intent_min_ada)
      |> assets.add(tok.policy, tok.name, da_tok),
    dep_datum(0, None),
  )
}

// happy: deposit 20M tok + 10M ADA, mint 100k shares, owner gets shares + 2M min back.
test deposit_ok() {
  let tx = fx(
    dep_intent(20_000_000, 10_000_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(220_000_000, 110_000_000, total_lp - 1_100_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, 100_000),
        None,
      ),
    ],
  )
  both(tx, dep_datum(90_000, None))
}

// minted shares below the owner floor: rejected.
test deposit_below_floor() fail {
  let tx = fx(
    dep_intent(20_000_000, 10_000_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(220_000_000, 110_000_000, total_lp - 1_100_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, 100_000),
        None,
      ),
    ],
  )
  both(tx, dep_datum(110_000, None))
}

// over-mint: same deposit but the pool releases 200k shares (circ +200k) — per-share
// backing in the POOL validator rejects it (owner pin passes, owner over-paid).
test deposit_over_mint() fail {
  let tx = fx(
    dep_intent(20_000_000, 10_000_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(220_000_000, 110_000_000, total_lp - 1_200_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, 200_000),
        None,
      ),
    ],
  )
  both(tx, dep_datum(0, None))
}

// batcher mints shares without actually depositing (pool reserves unchanged): the
// pool's per-share backing rejects it (you can't mint from a non-existent deposit).
test deposit_no_assets() fail {
  let tx = fx(
    dep_intent(20_000_000, 10_000_000),
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(200_000_000, 100_000_000, total_lp - 1_100_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000)
          |> assets.add(nft.policy, lp_name, 100_000),
        None,
      ),
    ],
  )
  both(tx, dep_datum(0, None))
}

// first deposit (circ_in == 0, pool holds all LP) is NOT intent-fulfillable: rejected.
test deposit_first_deposit_excluded() fail {
  let tx = fx(
    dep_intent(100_000_000, 100_000_000),
    pool_in(0, 0, total_lp),
    [
      pool_out(100_000_000, 100_000_000, total_lp - 100_000_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, 100_000_000),
        None,
      ),
    ],
  )
  only_fulfill(tx, dep_datum(0, None))
}

// an over-supplied side (extra ADA beyond the proportional deposit) and an incidental
// junk asset both ride BACK to the owner via the exact pin — never to the batcher.
test deposit_leftover_and_junk_to_owner() {
  // intent holds 20M tok + 5M extra ADA + (10M traded + tip + min) + 5 junk; the pool
  // only absorbs 20M tok / 10M ADA, so 5M ADA + 5 junk must return to the owner.
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(10_000_000 + 5_000_000 + tip + lp_intent_min_ada)
      |> assets.add(tok.policy, tok.name, 20_000_000)
      |> assets.add(junk.policy, junk.name, 5),
    dep_datum(0, None),
  )
  let tx = fx(
    intent,
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(220_000_000, 110_000_000, total_lp - 1_100_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 5_000_000)
          |> assets.add(nft.policy, lp_name, 100_000)
          |> assets.add(junk.policy, junk.name, 5),
        None,
      ),
    ],
  )
  both(tx, dep_datum(0, None))
}

// the same, but the batcher keeps the incidental junk (owner output omits it): the
// exact pin rejects it.
test deposit_junk_withheld() fail {
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(10_000_000 + tip + lp_intent_min_ada)
      |> assets.add(tok.policy, tok.name, 20_000_000)
      |> assets.add(junk.policy, junk.name, 5),
    dep_datum(0, None),
  )
  let tx = fx(
    intent,
    pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
    [
      pool_out(220_000_000, 110_000_000, total_lp - 1_100_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, 100_000),
        None,
      ),
    ],
  )
  both(tx, dep_datum(0, None))
}

// ===========================================================================
// SETTLEMENT-FOLD (adversarial-review regression) — a fulfillment must NEVER carry a
// settlement withdraw-0 for `S`. Otherwise a non-`S`-tagged victim pool could be spent
// via `PoolSettle` (which the anchor never enumerates, and whose k-check does NOT pin
// held LP), letting a deposit fulfill mint UNBACKED shares (reserves unchanged, held
// released). The `!withdrawal_present(S)` guard closes the fold — for both actions.
// ===========================================================================

test deposit_folded_into_settlement_rejected() fail {
  let tx = Transaction {
    ..fx(
      dep_intent(20_000_000, 10_000_000),
      pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
      [
        pool_out(220_000_000, 110_000_000, total_lp - 1_100_000),
        payout(
          assets.from_lovelace(lp_intent_min_ada)
            |> assets.add(nft.policy, lp_name, 100_000),
          None,
        ),
      ],
    ),
    withdrawals: [Pair(s(), 0)],
  }
  only_fulfill(tx, dep_datum(90_000, None))
}

test withdraw_folded_into_settlement_rejected() fail {
  let tx = Transaction {
    ..fx(
      wd_intent(100_000),
      pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
      [
        pool_out(180_000_000, 90_000_000, total_lp - 900_000),
        payout(
          assets.from_lovelace(lp_intent_min_ada + 10_000_000)
            |> assets.add(tok.policy, tok.name, 20_000_000),
          None,
        ),
      ],
    ),
    withdrawals: [Pair(s(), 0)],
  }
  only_fulfill(tx, wd_datum(0, 0, None))
}

// ===========================================================================
// TOKEN/TOKEN pool (no ADA side) — lovelace is tip + min only, never traded
// ===========================================================================

fn tt_datum() -> PoolDatum {
  PoolDatum {
    nft,
    asset_a: tok,
    asset_b: tokb,
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(creator_vkh),
  }
}

fn tt_val(res_a: Int, res_b: Int, held: Int) -> Value {
  assets.from_lovelace(pool_min_ada)
    |> assets.add(tok.policy, tok.name, res_a)
    |> assets.add(tokb.policy, tokb.name, res_b)
    |> assets.add(nft.policy, nft.name, 1)
    |> assets.add(nft.policy, lp_name, held)
}

fn tt_pool(res_a: Int, res_b: Int, held: Int) -> Output {
  Output {
    address: pool_addr(),
    value: tt_val(res_a, res_b, held),
    datum: InlineDatum(tt_datum()),
    reference_script: None,
  }
}

// token/token deposit: 10M tok + 20M tokb, mint 100k shares; owner gets shares + min.
test deposit_token_token() {
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(tip + lp_intent_min_ada)
      |> assets.add(tok.policy, tok.name, 10_000_000)
      |> assets.add(tokb.policy, tokb.name, 20_000_000),
    dep_datum(0, None),
  )
  let p_in = Input {
    output_reference: pool_ref(),
    output: tt_pool(100_000_000, 200_000_000, total_lp - 1_000_000),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [intent, p_in],
    outputs: [
      tt_pool(110_000_000, 220_000_000, total_lp - 1_100_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, 100_000),
        None,
      ),
    ],
  }
  lp_intent.fulfill(tx, intent_ref(), dep_datum(90_000, None), s()) && spend.lp_action(
    tx,
    pool_ref(),
    tt_datum(),
  )
}

// token/token withdraw: burn 100k LP, release 10M tok + 20M tokb.
test withdraw_token_token() {
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(tip + lp_intent_min_ada)
      |> assets.add(nft.policy, lp_name, 100_000),
    wd_datum(0, 0, None),
  )
  let p_in = Input {
    output_reference: pool_ref(),
    output: tt_pool(100_000_000, 200_000_000, total_lp - 1_000_000),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [intent, p_in],
    outputs: [
      tt_pool(90_000_000, 180_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(tok.policy, tok.name, 10_000_000)
          |> assets.add(tokb.policy, tokb.name, 20_000_000),
        None,
      ),
    ],
  }
  lp_intent.fulfill(
    tx,
    intent_ref(),
    wd_datum(9_000_000, 18_000_000, None),
    s(),
  ) && spend.lp_action(tx, pool_ref(), tt_datum())
}

// ===========================================================================
// POOL-OUTPUT FULL-VALUE PIN (adversarial-review low findings #2/#3) — fulfill pins
// the pool output EXACTLY (pool_in shifted by the reserve/held deltas), so a batcher
// can't sweep the pool's overhead lovelace or any incidental/airdropped asset. This is
// STRICTER than the frozen direct LpAction path (which leaves them unpinned).
// ===========================================================================

// token/token: batcher drops 500_000 of the pool's overhead lovelace → rejected.
test withdraw_tt_overhead_skim_rejected() fail {
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(tip + lp_intent_min_ada)
      |> assets.add(nft.policy, lp_name, 100_000),
    wd_datum(0, 0, None),
  )
  let p_in = Input {
    output_reference: pool_ref(),
    output: tt_pool(100_000_000, 200_000_000, total_lp - 1_000_000),
  }
  let p_out = Output {
    address: pool_addr(),
    value: assets.from_lovelace(pool_min_ada - 500_000)
      |> assets.add(tok.policy, tok.name, 90_000_000)
      |> assets.add(tokb.policy, tokb.name, 180_000_000)
      |> assets.add(nft.policy, nft.name, 1)
      |> assets.add(nft.policy, lp_name, total_lp - 900_000),
    datum: InlineDatum(tt_datum()),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [intent, p_in],
    outputs: [
      p_out,
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(tok.policy, tok.name, 10_000_000)
          |> assets.add(tokb.policy, tokb.name, 20_000_000),
        None,
      ),
    ],
  }
  lp_intent.fulfill(tx, intent_ref(), wd_datum(0, 0, None), s())
}

// the pool carries an incidental airdropped asset; the batcher strips it → rejected
// (pool_out must keep everything the pool_in held except the reserve/held deltas).
test withdraw_pool_incidental_stripped_rejected() fail {
  let p_in = Input {
    output_reference: pool_ref(),
    output: Output {
      address: pool_addr(),
      value: pool_val(200_000_000, 100_000_000, total_lp - 1_000_000)
        |> assets.add(junk.policy, junk.name, 7),
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
  let tx = fx(
    wd_intent(100_000),
    p_in,
    [
      // omits the 7 junk the pool held
      pool_out(180_000_000, 90_000_000, total_lp - 900_000),
      payout(
        assets.from_lovelace(lp_intent_min_ada + 10_000_000)
          |> assets.add(tok.policy, tok.name, 20_000_000),
        None,
      ),
    ],
  )
  only_fulfill(tx, wd_datum(0, 0, None))
}

// ===========================================================================
// RECLAIM
// ===========================================================================

// owner signs: reclaim ok (returns LP tokens for a withdraw-intent, A+B for a deposit;
// withdraw-reclaim returns LP, NOT underlying — §13.11).
test reclaim_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    extra_signatories: [owner_vkh],
  }
  lp_intent.reclaim(owner(), tx)
}

// no owner signature: rejected (non-custodial — only the owner can reclaim).
test reclaim_no_sig() fail {
  lp_intent.reclaim(owner(), transaction.placeholder)
}

// a Script-credential owner can never reclaim by signature (v1 VK-owner precondition).
test reclaim_script_owner() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    extra_signatories: [owner_vkh],
  }
  lp_intent.reclaim(Script(li_hash), tx)
}

// ===========================================================================
// PROPERTY TESTS (aiken/fuzz) — the math is internally consistent across random
// reserves/amounts, and both validators agree.
// ===========================================================================

fn res_pair() -> Fuzzer<(Int, Int)> {
  fuzz.both(
    fuzz.int_between(1_000_000, 1_000_000_000),
    fuzz.int_between(1_000_000, 1_000_000_000),
  )
}

// PROPERTY: a floor-computed proportional withdraw (release = floor(L·res/circ)) is
// always accepted — per-share backing holds (floor under-releases) and the exact owner
// pin matches. circ_in fixed at 1_000_000; L in [1, 900_000].
test prop_withdraw_proportional(
  p via fuzz.both(fuzz.int_between(1, 900_000), res_pair()),
) {
  let (l, reserves) = p
  let (res_tok, res_ada) = reserves
  let circ_in = 1_000_000
  let rel_tok = l * res_tok / circ_in
  let rel_ada = l * res_ada / circ_in
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(lp_intent_min_ada + tip)
      |> assets.add(nft.policy, lp_name, l),
    wd_datum(0, 0, None),
  )
  let tx = fx(
    intent,
    pool_in(res_tok, res_ada, total_lp - circ_in),
    [
      pool_out(res_tok - rel_tok, res_ada - rel_ada, total_lp - ( circ_in - l )),
      payout(
        assets.from_lovelace(lp_intent_min_ada + rel_ada)
          |> assets.add(tok.policy, tok.name, rel_tok),
        None,
      ),
    ],
  )
  both(tx, wd_datum(0, 0, None))
}

// PROPERTY: a ceil-computed proportional deposit (dep = ceil(shares·res/circ)) always
// mints `shares` and is accepted — per-share backing holds (ceil over-deposits).
test prop_deposit_proportional(
  p via fuzz.both(fuzz.int_between(1, 900_000), res_pair()),
) {
  let (shares, reserves) = p
  let (res_tok, res_ada) = reserves
  let circ_in = 1_000_000
  let dep_tok = ( res_tok * shares + circ_in - 1 ) / circ_in
  let dep_ada = ( res_ada * shares + circ_in - 1 ) / circ_in
  let intent = intent_at(
    intent_ref(),
    assets.from_lovelace(dep_ada + tip + lp_intent_min_ada)
      |> assets.add(tok.policy, tok.name, dep_tok),
    dep_datum(0, None),
  )
  let tx = fx(
    intent,
    pool_in(res_tok, res_ada, total_lp - circ_in),
    [
      pool_out(
        res_tok + dep_tok,
        res_ada + dep_ada,
        total_lp - ( circ_in + shares ),
      ),
      payout(
        assets.from_lovelace(lp_intent_min_ada)
          |> assets.add(nft.policy, lp_name, shares),
        None,
      ),
    ],
  )
  both(tx, dep_datum(shares, None))
}

// ---- benches: fulfillment hot paths (the new immutable validator's ex-units) ----

fn withdraw_bench_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    fx(
      wd_intent(100_000),
      pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
      [
        pool_out(180_000_000, 90_000_000, total_lp - 900_000),
        payout(
          assets.from_lovelace(lp_intent_min_ada + 10_000_000)
            |> assets.add(tok.policy, tok.name, 20_000_000),
          None,
        ),
      ],
    ),
  )
}

bench lp_intent__fulfill__withdraw(tx via withdraw_bench_tx) {
  lp_intent.fulfill(tx, intent_ref(), wd_datum(0, 0, None), s())
}

fn deposit_bench_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    fx(
      dep_intent(20_000_000, 10_000_000),
      pool_in(200_000_000, 100_000_000, total_lp - 1_000_000),
      [
        pool_out(220_000_000, 110_000_000, total_lp - 1_100_000),
        payout(
          assets.from_lovelace(lp_intent_min_ada)
            |> assets.add(nft.policy, lp_name, 100_000),
          None,
        ),
      ],
    ),
  )
}

bench lp_intent__fulfill__deposit(tx via deposit_bench_tx) {
  lp_intent.fulfill(tx, intent_ref(), dep_datum(0, None), s())
}
