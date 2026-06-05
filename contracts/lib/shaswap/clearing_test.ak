//// Tests for the production settlement anchor + order/pool validators (Rev 6).
//// Synthesises settlements with the stake-credential-tag wiring and checks the
//// §5.2 guarantees hold (happy path) and the §5.4/§8 safety properties bite
//// (floor breach, mis-binding, value theft, fake pool, untagged smuggle, k drop).

use aiken/collection/list
use aiken/fuzz
use aiken/interval.{Interval}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/certificate.{
  AlwaysAbstain, DelegateCredential, DelegateVote, RegisterCredential,
  UnregisterCredential,
}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use shaswap/clearing
use shaswap/constants.{lp_name, order_min_ada, pool_min_ada, total_lp}
use shaswap/spend
use shaswap/types.{
  AssetId, BoundDatum, OrderDatum, PoolDatum, SettlementRedeemer,
}

// ---- fixtures -------------------------------------------------------------

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const o_hash = #"0000000000000000000000000000000000000000000000000000000b"

const p_hash = #"9999999999999999999999999999999999999999999999999999999c"

const owner_vkh = #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

const solver_vkh = #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

const order_txid =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const pool_txid =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

const nft =
  AssetId {
    policy: #"4444444444444444444444444444444444444444444444444444444e",
    name: #"4e4654",
  }

// ADA-paired pools: asset_a = the token, asset_b = ADA (policy/name = "").
const ada = AssetId { policy: #"", name: #"" }

const sell = 1_000_000

const tip = 2_000_000

const min_ada = 2_000_000

const order_in_ada = min_ada + tip

const received = 500_000

// sell * 1 / 2

const limit = 400_000

const owner_out_ada = order_in_ada - tip + received

const pool_ada_in = 1_000_000_000_000

const pool_tok_in = 1_000_000_000_000

fn s() -> Credential {
  Script(s_hash)
}

fn redeemer(fills: List<Int>) -> SettlementRedeemer {
  SettlementRedeemer {
    price_num: 1,
    price_den: 2,
    asset_a: tok,
    asset_b: ada,
    pool_nft: nft,
    fills,
  }
}

fn tagged(c: Credential) -> Address {
  Address { payment_credential: c, stake_credential: Some(Inline(s())) }
}

fn plain(c: Credential) -> Address {
  Address { payment_credential: c, stake_credential: None }
}

fn tok_val(lovelace: Int, t: Int) -> Value {
  assets.from_lovelace(lovelace) |> assets.add(tok.policy, tok.name, t)
}

fn pool_val(lovelace: Int, t: Int) -> Value {
  tok_val(lovelace, t) |> assets.add(nft.policy, nft.name, 1)
}

fn order_ref(i: Int) -> OutputReference {
  OutputReference { transaction_id: order_txid, output_index: i }
}

fn pool_ref() -> OutputReference {
  OutputReference { transaction_id: pool_txid, output_index: 0 }
}

fn order_datum() -> OrderDatum {
  OrderDatum {
    owner: VerificationKey(owner_vkh),
    owner_stake: None,
    pool_nft: nft,
    sell_a: True,
    sell_amount: sell,
    limit,
    tip,
    partial: False,
    deadline: None,
  }
}

fn pool_datum() -> PoolDatum {
  PoolDatum {
    nft,
    asset_a: tok,
    asset_b: ada,
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(owner_vkh),
  }
}

// ---- builders -------------------------------------------------------------

fn order_input(i: Int, tagged_in: Bool) -> Input {
  let addr = if tagged_in {
    tagged(Script(o_hash))
  } else {
    plain(Script(o_hash))
  }
  Input {
    output_reference: order_ref(i),
    output: Output {
      address: addr,
      value: tok_val(order_in_ada, sell),
      datum: InlineDatum(order_datum()),
      reference_script: None,
    },
  }
}

fn owner_output(bind_index: Int, ada: Int) -> Output {
  Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(ada),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(bind_index) }),
    reference_script: None,
  }
}

fn pool_input(with_nft: Bool) -> Input {
  let v = if with_nft {
    pool_val(pool_ada_in, pool_tok_in)
  } else {
    tok_val(pool_ada_in, pool_tok_in)
  }
  Input {
    output_reference: pool_ref(),
    output: Output {
      address: tagged(Script(p_hash)),
      value: v,
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
}

fn pool_output(ada: Int, t: Int) -> Output {
  Output {
    address: tagged(Script(p_hash)),
    value: pool_val(ada, t),
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

fn solver_output(ada: Int) -> Output {
  Output {
    address: plain(VerificationKey(solver_vkh)),
    value: assets.from_lovelace(ada),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

// ADA-seller: sells `sell_ada_amt` lovelace (asset_b), buys token (limit `lim`).
fn ada_order_input(i: Int, sell_ada_amt: Int, lim: Int) -> Input {
  Input {
    output_reference: order_ref(i),
    output: Output {
      address: tagged(Script(o_hash)),
      value: assets.from_lovelace(sell_ada_amt + tip + min_ada),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          owner_stake: None,
          pool_nft: nft,
          sell_a: False,
          sell_amount: sell_ada_amt,
          limit: lim,
          tip,
          partial: False,
          deadline: None,
        },
      ),
      reference_script: None,
    },
  }
}

// owner-output for an ADA-seller: receives `recv_tok` token + its min-ADA back.
fn tok_owner_output(bind_index: Int, recv_tok: Int, min_back: Int) -> Output {
  Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(min_back)
      |> assets.add(tok.policy, tok.name, recv_tok),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(bind_index) }),
    reference_script: None,
  }
}

/// Happy multi-order settlement.
fn build(n: Int) -> Transaction {
  let ids = list.range(0, n - 1)
  let orders = list.map(ids, fn(i) { order_input(i, True) })
  let owners = list.map(ids, fn(i) { owner_output(i, owner_out_ada) })
  Transaction {
    ..transaction.placeholder,
    inputs: list.concat(orders, [pool_input(True)]),
    outputs: list.concat(
      owners,
      [
        pool_output(pool_ada_in - received * n, pool_tok_in + sell * n),
        solver_output(tip * n),
      ],
    ),
    withdrawals: [Pair(s(), 0)],
  }
}

/// Single-order settlement with knobs for negative tests.
fn build1(
  owner_ada: Int,
  bind_index: Int,
  pool_ada_out: Int,
  pool_tok_out: Int,
  pool_nft: Bool,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(pool_nft)],
    outputs: [
      owner_output(bind_index, owner_ada),
      pool_output(pool_ada_out, pool_tok_out),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
}

// ---- happy path -----------------------------------------------------------

test happy_n1() {
  clearing.run(
    s(),
    redeemer([sell]),
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

test happy_n3() {
  clearing.run(s(), redeemer(list.repeat(sell, 3)), build(3))
}

test happy_n20() {
  clearing.run(s(), redeemer(list.repeat(sell, 20)), build(20))
}

// ---- settlement negatives -------------------------------------------------

// trader paid less than `received` (pool keeps 100 extra ADA): conservation +
// traded-ADA role both bite.
test neg_value_theft() fail {
  clearing.run(
    s(),
    redeemer([sell]),
    build1(
      owner_out_ada - 100,
      0,
      pool_ada_in - received + 100,
      pool_tok_in + sell,
      True,
    ),
  )
}

// owner-output bound to the wrong order ref (double-satisfaction / mis-binding).
test neg_misbinding() fail {
  clearing.run(
    s(),
    redeemer([sell]),
    build1(owner_out_ada, 7, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// the "pool" input carries no NFT — a solver trying to pass something off as the
// pool is rejected.
test neg_fake_pool_no_nft() fail {
  clearing.run(
    s(),
    redeemer([sell]),
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, False),
  )
}

// floor breach: an order whose own limit exceeds what the clearing price yields.
fn order_input_lim(lim: Int) -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(order_in_ada, sell),
      datum: InlineDatum(OrderDatum { ..order_datum(), limit: lim }),
      reference_script: None,
    },
  }
}

test neg_floor_breach() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input_lim(received + 1), pool_input(True)],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// ---- settlement `publish` authority (audit I-06) --------------------------
// `clearing.allow_registration` IS the settlement `publish` handler. S authorizes
// ONLY its own registration — never de-registration or delegation — keeping the
// withdraw-0 anchor immortal and undelegatable (§5.4). The prior note claimed the
// `RegisterCredential.deposit: Never` field was impractical to construct; it is not
// (`Never` is a prelude constructor), so the authority is unit-tested here directly.
// (The `settlement.publish` entrypoint wiring — a 1-line delegation to this — is
// driven through the real validator in `validators/settlement.test.ak`.)

// accepts registration of S (the only path that brings the anchor into existence).
test allow_registration_accepts_register() {
  clearing.allow_registration(
    RegisterCredential { credential: s(), deposit: Never },
  )
}

// rejects de-registration: a griefer must never un-register S and brick every
// settlement.
test allow_registration_rejects_unregister() fail {
  clearing.allow_registration(
    UnregisterCredential { credential: s(), refund: Never },
  )
}

// rejects delegation: S must stay undelegatable so its (always-zero) rewards can
// never be captured.
test allow_registration_rejects_delegate() fail {
  clearing.allow_registration(
    DelegateCredential {
      credential: s(),
      delegate: DelegateVote { delegate_representative: AlwaysAbstain },
    },
  )
}

// ---- order validator logic ------------------------------------------------

test order_settle_ok() {
  spend.order_settle(build(1), order_ref(0), s())
}

// an order whose own input is NOT tagged with S cannot defer (input-smuggle §8).
test order_settle_untagged() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, False)],
    withdrawals: [Pair(s(), 0)],
  }
  spend.order_settle(tx, order_ref(0), s())
}

// no settlement withdraw present => deferral refused.
test order_settle_no_withdrawal() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True)],
  }
  spend.order_settle(tx, order_ref(0), s())
}

test order_reclaim_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    extra_signatories: [owner_vkh],
  }
  spend.order_reclaim(VerificationKey(owner_vkh), tx)
}

test order_reclaim_no_sig() fail {
  spend.order_reclaim(VerificationKey(owner_vkh), transaction.placeholder)
}

// (audit L-01) an order created with a Script-credential owner can be SETTLED but
// never RECLAIMED — reclaim requires a VK owner. Documents the lock-forever edge: it
// is self-inflicted (the order creator chooses `owner`) and the off-chain builder
// MUST use a VK owner to keep the §5.1 non-custodial reclaim guarantee.
test reclaim_script_owner() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    extra_signatories: [owner_vkh],
  }
  spend.order_reclaim(Script(o_hash), tx)
}

// ---- pool validator logic (owns k) ----------------------------------------

// (Rev 25) The pool must pay the FAIR curve amount. The ADA reserve has pool_min_ada
// carved out (reserve_of), so res_b_in = pool_ada_in − pool_min_ada = 999_998_000_000, and
// get_amount_out(sell=1_000_000, res_in=1e12 token, res_out=999_998_000_000, φ=0.3%) =
// 996_997 ADA. n_orders=1, so the pin allows ≤1 sub-unit dust; paying exactly fair clears it.
test pool_settle_ok() {
  let fair = spend.get_amount_out(sell, pool_tok_in, pool_ada_in - pool_min_ada, 3, 1000)
  let tx = build1(owner_out_ada, 0, pool_ada_in - fair, pool_tok_in + sell, True)
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

// (Rev 25) The pre-pin floor→fair corridor: pay the trader only `received`=500_000 for
// 1_000_000 token worth ~996_999 at the curve, banking the ~497k gap into k. The old
// one-sided k-check accepted this (k rises); the two-sided pin REJECTS it (underpayment
// ≫ the n_orders dust band). This is the economic fix, asserted on-chain.
test pool_settle_corridor() fail {
  spend.pool_settle(build(1), pool_ref(), pool_datum(), s())
}

// (Rev 25) dust band — build(1) has n_orders=1, so the pin tolerates ≤1 sub-unit of
// per-order flooring: paying fair−1 (996_996) still clears (a legitimate honest-rounding
// solve must never be rejected).
test pool_settle_dust_ok() {
  let fair = spend.get_amount_out(sell, pool_tok_in, pool_ada_in - pool_min_ada, 3, 1000)
  let tx = build1(owner_out_ada, 0, pool_ada_in - ( fair - 1 ), pool_tok_in + sell, True)
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

// (Rev 25) one sub-unit past the band — paying fair−2 (996_995) at n_orders=1 underpays
// beyond the dust tolerance and is REJECTED. Pins the band tight (ungameable to ≤ n_orders).
test pool_settle_dust_reject() fail {
  let fair = spend.get_amount_out(sell, pool_tok_in, pool_ada_in - pool_min_ada, 3, 1000)
  let tx = build1(owner_out_ada, 0, pool_ada_in - ( fair - 2 ), pool_tok_in + sell, True)
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

// k decreases (pool pays out ADA without gaining token): rejected.
test pool_settle_k_drop() fail {
  let tx = build1(owner_out_ada, 0, pool_ada_in - 2_000_000, pool_tok_in, True)
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

// (H2 defense-in-depth) pool_settle rejects when the SPENT INPUT doesn't carry the
// pool NFT — the pool owns its own continuity, independent of the settlement anchor.
test pool_settle_input_no_nft() fail {
  let tx = build1(
    owner_out_ada,
    0,
    pool_ada_in - received,
    pool_tok_in + sell,
    False,
  )
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

// (H3 defense-in-depth) pool_settle rejects an output whose ADA reserve is driven
// below zero (lovelace < pool_min_ada): explicit guard (also caught by the k-check).
test pool_settle_negative_reserve() fail {
  let tx = build1(owner_out_ada, 0, 1, pool_tok_in + sell, True)
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

// ---- bidirectional netting (the batch-auction benefit) --------------------
// price p = 1/2 ADA per token, so 1 token -> 0.5 ADA and 1 ADA -> 2 token.

// One token-seller (1_000_000 token -> 500_000 ADA) and one ADA-seller
// (500_000 lovelace -> 1_000_000 token) net PERFECTLY: the pool is untouched.
test netting_perfect() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [
      order_input(0, True),
      ada_order_input(1, 500_000, 1_000_000),
      pool_input(True),
    ],
    outputs: [
      owner_output(0, owner_out_ada),
      tok_owner_output(1, 1_000_000, min_ada),
      pool_output(pool_ada_in, pool_tok_in),
      solver_output(tip * 2),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell, 500_000]), tx)
}

// Partial netting: token-seller 1_000_000 token, ADA-seller only 250_000
// lovelace (-> 500_000 token). Net residual hits the pool: +500_000 token,
// -250_000 ADA.
test netting_partial() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [
      order_input(0, True),
      ada_order_input(1, 250_000, 500_000),
      pool_input(True),
    ],
    outputs: [
      owner_output(0, owner_out_ada),
      tok_owner_output(1, 500_000, min_ada),
      pool_output(pool_ada_in - 250_000, pool_tok_in + 500_000),
      solver_output(tip * 2),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell, 250_000]), tx)
}

// A lone ADA-seller: pool absorbs the whole trade (sells 500_000 lovelace,
// buys 1_000_000 token; pool +500_000 ADA, -1_000_000 token).
test ada_seller_solo() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [ada_order_input(0, 500_000, 1_000_000), pool_input(True)],
    outputs: [
      tok_owner_output(0, 1_000_000, min_ada),
      pool_output(pool_ada_in + 500_000, pool_tok_in - 1_000_000),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([500_000]), tx)
}

// ADA-seller floor breach: demands more token than the clearing price yields.
test ada_seller_floor() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [ada_order_input(0, 500_000, 1_000_001), pool_input(True)],
    outputs: [
      tok_owner_output(0, 1_000_000, min_ada),
      pool_output(pool_ada_in + 500_000, pool_tok_in - 1_000_000),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([500_000]), tx)
}

// Pool not credited the netted residual (solver tries to skim the token the
// ADA-seller didn't take): pool token movement check bites.
test netting_pool_shorted() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [
      order_input(0, True),
      ada_order_input(1, 250_000, 500_000),
      pool_input(True),
    ],
    outputs: [
      owner_output(0, owner_out_ada),
      tok_owner_output(1, 500_000, min_ada),
      // pool should gain +500_000 token; credit it 0 instead
      pool_output(pool_ada_in - 250_000, pool_tok_in),
      solver_output(tip * 2),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell, 250_000]), tx)
}

// ---- deadlines ------------------------------------------------------------

fn order_input_deadline(d: Option<Int>) -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(order_in_ada, sell),
      datum: InlineDatum(OrderDatum { ..order_datum(), deadline: d }),
      reference_script: None,
    },
  }
}

fn deadline_tx(d: Option<Int>, range: Interval) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [order_input_deadline(d), pool_input(True)],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
    validity_range: range,
  }
}

// settled before the deadline: ok.
test deadline_within() {
  clearing.run(
    s(),
    redeemer([sell]),
    deadline_tx(Some(1000), interval.before(900)),
  )
}

// tx could be included after the deadline: rejected.
test deadline_expired() fail {
  clearing.run(
    s(),
    redeemer([sell]),
    deadline_tx(Some(1000), interval.before(1500)),
  )
}

// open-ended tx can't honor a deadline: rejected.
test deadline_open_tx() fail {
  clearing.run(
    s(),
    redeemer([sell]),
    deadline_tx(Some(1000), interval.everything),
  )
}

// no deadline: an open-ended tx is fine.
test deadline_none_open_ok() {
  clearing.run(s(), redeemer([sell]), deadline_tx(None, interval.everything))
}

// ---- partial fills (proportional tip) -------------------------------------
// A partial-eligible order pre-funds tip + 2*order_min_ada. On a partial fill
// the solver takes tip*f/sell now; the remainder keeps the rest + one min-ADA.

fn partial_token_order(allow_partial: Bool) -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(tip + 2 * order_min_ada, sell),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          owner_stake: None,
          pool_nft: nft,
          sell_a: True,
          sell_amount: sell,
          limit,
          tip,
          partial: allow_partial,
          deadline: None,
        },
      ),
      reference_script: None,
    },
  }
}

fn partial_ada_order() -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: assets.from_lovelace(1_000_000 + tip + 2 * order_min_ada),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          owner_stake: None,
          pool_nft: nft,
          sell_a: False,
          sell_amount: 1_000_000,
          limit: 1_500_000,
          tip,
          partial: True,
          deadline: None,
        },
      ),
      reference_script: None,
    },
  }
}

fn remainder_output(
  is_ada: Bool,
  tok_amt: Int,
  ada_amt: Int,
  sell2: Int,
  lim2: Int,
  tip2: Int,
) -> Output {
  Output {
    address: tagged(Script(o_hash)),
    value: tok_val(ada_amt, tok_amt),
    datum: InlineDatum(
      OrderDatum {
        owner: VerificationKey(owner_vkh),
        owner_stake: None,
        pool_nft: nft,
        // is_ada = the order sells ADA (asset_b) ⟺ sell_a == False
        sell_a: !is_ada,
        sell_amount: sell2,
        limit: lim2,
        tip: tip2,
        partial: False,
        deadline: None,
      },
    ),
    reference_script: None,
  }
}

// token-seller fills 400_000 of 1_000_000 at p=1/2: gets 200_000 ADA; remainder
// holds 600_000 token + (min + leftover tip 1_200_000); solver takes 800_000 tip.
test partial_token_seller() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(True), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      remainder_output(False, 600_000, 3_200_000, 600_000, 240_000, 1_200_000),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// ADA-seller fills 400_000 of 1_000_000 lovelace: gets 800_000 token; remainder
// holds 600_000 unsold ADA + min + leftover tip.
test partial_ada_seller() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_ada_order(), pool_input(True)],
    outputs: [
      tok_owner_output(0, 800_000, 2_000_000),
      pool_output(pool_ada_in + 400_000, pool_tok_in - 800_000),
      remainder_output(True, 0, 3_800_000, 600_000, 900_000, 1_200_000),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// partial fill of an order that doesn't allow partials: rejected.
test partial_not_allowed() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(False), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      remainder_output(False, 600_000, 3_200_000, 600_000, 240_000, 1_200_000),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// remainder shorted (holds 500_000 < 600_000 unsold token): user robbed, rejected.
test partial_remainder_shorted() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(True), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      remainder_output(False, 500_000, 3_200_000, 600_000, 240_000, 1_200_000),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// remainder limit price worse than original (100_000 < proportional 240_000): rejected.
test partial_remainder_bad_limit() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(True), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      remainder_output(False, 600_000, 3_200_000, 600_000, 100_000, 1_200_000),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// (H-01) the token-seller partial remainder (600_000 unsold token + min + leftover
// tip 1_200_000), but with a caller-chosen `pool_nft` so we can prove the rollover
// is re-bound to the original order's pool.
fn partial_remainder_with_pool_nft(pn: AssetId) -> Output {
  Output {
    address: tagged(Script(o_hash)),
    value: tok_val(3_200_000, 600_000),
    datum: InlineDatum(
      OrderDatum {
        owner: VerificationKey(owner_vkh),
        owner_stake: None,
        pool_nft: pn,
        sell_a: True,
        sell_amount: 600_000,
        limit: 240_000,
        tip: 1_200_000,
        partial: False,
        deadline: None,
      },
    ),
    reference_script: None,
  }
}

// (H-01) the remainder re-points the unsold portion at an ATTACKER pool (`pool_nft`
// = Q with a worthless asset_b). Before the `expect ro.pool_nft == order.pool_nft`
// pin this passed (the bug): the solver could later settle the remainder against Q
// and satisfy the bare-int floor with junk, rugging the unsold balance. Must be
// rejected now.
test partial_remainder_wrong_pool_nft() fail {
  let attacker_nft = AssetId {
    policy: #"7777777777777777777777777777777777777777777777777777777f",
    name: #"4e4654",
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(True), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      partial_remainder_with_pool_nft(attacker_nft),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// PROPERTY (H-01): any remainder `pool_nft` other than the original order's is
// rejected — fuzz the remainder's target NFT policy across the whole non-matching
// space (mirrors `prop_reject_order_wrong_pool` for the rollover site).
test prop_partial_remainder_wrong_pool_nft(pol via nonempty_policy()) fail {
  let other = AssetId { policy: pol, name: #"4e4654" }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(True), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      partial_remainder_with_pool_nft(other),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// ---- pool held-LP continuity (C1: the reserve-drain blocker) --------------
// A live pool holds `total_lp − circ` LP. The settlement must pin it so a solver
// can't strip the held LP into its own change (and later drain reserves via an
// LpAction). Earlier code pinned only the pool's ADA + token, not its LP.

const lp_held = total_lp - 1_000_000

fn pool_input_lp(held: Int) -> Input {
  Input {
    output_reference: pool_ref(),
    output: Output {
      address: tagged(Script(p_hash)),
      value: pool_val(pool_ada_in, pool_tok_in)
        |> assets.add(nft.policy, lp_name, held),
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
}

fn pool_output_lp(ada: Int, t: Int, held: Int) -> Output {
  Output {
    address: tagged(Script(p_hash)),
    value: pool_val(ada, t) |> assets.add(nft.policy, lp_name, held),
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

// single token-seller settlement; pool carries its held LP both sides.
fn build1_lp(pool_held_out: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input_lp(lp_held)],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output_lp(pool_ada_in - received, pool_tok_in + sell, pool_held_out),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
}

// held LP preserved across the settlement: ok.
test settlement_preserves_pool_lp() {
  clearing.run(s(), redeemer([sell]), build1_lp(lp_held))
}

// solver strips the pool's held LP (output carries 0 LP): rejected.
test settlement_strip_pool_lp() fail {
  clearing.run(s(), redeemer([sell]), build1_lp(0))
}

// solver siphons even a single LP token off the pool: rejected.
test settlement_skim_one_lp() fail {
  clearing.run(s(), redeemer([sell]), build1_lp(lp_held - 1))
}

// ---- N=0 settlement (empty batch) -----------------------------------------
// A pool-only settlement must still pin the pool exactly (incl. held LP).

test settlement_n0_preserves_lp() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_input_lp(lp_held)],
    outputs: [pool_output_lp(pool_ada_in, pool_tok_in, lp_held)],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([]), tx)
}

// an empty batch that strips LP from the pool: rejected.
test settlement_n0_strip_lp() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_input_lp(lp_held)],
    outputs: [pool_output_lp(pool_ada_in, pool_tok_in, 0)],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([]), tx)
}

// ---- incidental-asset pass-through (H2) -----------------------------------
// An order UTXO that also carries an unrelated asset must return it to the owner;
// the solver can't route it to itself. Owner/remainder/pool pin FULL value now.

const junk =
  AssetId {
    policy: #"7777777777777777777777777777777777777777777777777777777f",
    name: #"6a6e6b",
  }

fn order_input_junk() -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(order_in_ada, sell)
        |> assets.add(junk.policy, junk.name, 5),
      datum: InlineDatum(order_datum()),
      reference_script: None,
    },
  }
}

// owner output returns the incidental asset: ok.
test settlement_junk_returned_ok() {
  let owner_out = Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(owner_out_ada)
      |> assets.add(junk.policy, junk.name, 5),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input_junk(), pool_input(True)],
    outputs: [
      owner_out,
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// owner output omits the incidental asset (solver keeps it): rejected.
test settlement_junk_leak_rejected() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input_junk(), pool_input(True)],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// ---- pool datum continuity (H3) -------------------------------------------
// The pool's datum (identity / fee params) can't be mutated mid-settlement.

test settlement_pool_datum_mutation() fail {
  let bad_pool = Output {
    address: tagged(Script(p_hash)),
    value: pool_val(pool_ada_in - received, pool_tok_in + sell),
    datum: InlineDatum(PoolDatum { ..pool_datum(), fee_num: 999 }),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(True)],
    outputs: [owner_output(0, owner_out_ada), bad_pool, solver_output(tip)],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// ---- declared pair must be non-degenerate (asset_a != asset_b) -------------

test settlement_degenerate_pair() fail {
  // asset_a == asset_b (both ADA) collapses the pair: rejected.
  let bad = SettlementRedeemer { ..redeemer([sell]), asset_a: ada }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// ---- identity binding: redeemer pair/NFT bound to the PoolDatum (C-01/C-02) ---
// The solver-declared `asset_a`/`asset_b`/`pool_nft` are pinned to the spent pool's
// real datum pair, and each order consents to `pool_nft`. This closes (C-01) the
// LP/NFT-alias reserve drain and (C-02) the unbound-bought-asset owner rug.

// (C-01) declaring the pool's own LP token as the traded `asset_b` is rejected:
// it doesn't equal the pool's real `asset_b` (ada), so the binding bites.
test settlement_alias_lp_as_asset_b() fail {
  let bad = SettlementRedeemer {
    ..redeemer([sell]),
    asset_b: AssetId { policy: nft.policy, name: lp_name },
  }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// (C-01) aliasing `asset_a` to the pool's own NFT is likewise rejected.
test settlement_alias_nft_as_asset_a() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), asset_a: nft }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// (H1 defense-in-depth) Even a MALFORMED pool whose own datum declares a traded
// asset under the pool's OWN policy — which `mint.create` rejects, but the immutable
// anchor must not depend on that — is fenced off by the anchor's own self-check. Here
// the redeemer matches the (bad) datum pair, so the PoolDatum binding passes, yet the
// `asset.policy != pool_nft.policy` guard still bites.
test settlement_anchor_fences_pool_policy_asset() fail {
  let bad_asset = AssetId { policy: nft.policy, name: #"54" }
  let pool_in = Input {
    output_reference: pool_ref(),
    output: Output {
      address: tagged(Script(p_hash)),
      value: pool_val(pool_ada_in, pool_tok_in),
      datum: InlineDatum(PoolDatum { ..pool_datum(), asset_a: bad_asset }),
      reference_script: None,
    },
  }
  let r = SettlementRedeemer { ..redeemer([sell]), asset_a: bad_asset }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_in],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), r, tx)
}

// (C-02) the solver swaps in a worthless bought asset (`asset_b` != the pool's
// real `asset_b`): the PoolDatum pair-binding rejects it, so the owner can never
// be paid a token of the solver's choosing.
test settlement_wrong_bought_asset() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), asset_b: junk }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// (C-02) a sold-asset substitution (`asset_a` != the pool's real `asset_a`) is
// rejected by the same binding.
test settlement_wrong_sold_asset() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), asset_a: junk }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// A pool nft distinct from the one this order/redeemer target.
const other_nft =
  AssetId {
    policy: #"1212121212121212121212121212121212121212121212121212121a",
    name: #"4e4654",
  }

fn order_input_pool(pn: AssetId) -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(order_in_ada, sell),
      datum: InlineDatum(OrderDatum { ..order_datum(), pool_nft: pn }),
      reference_script: None,
    },
  }
}

// (C-02) an order that consents to a DIFFERENT pool than the one being settled is
// rejected — it can't be dragged into a pool it never agreed to.
test settlement_order_wrong_pool() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input_pool(other_nft), pool_input(True)],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// (C-02) the redeemer's `pool_nft` must equal the spent pool's datum NFT — a
// redeemer naming a foreign NFT (that the pool input doesn't carry) is rejected.
test settlement_redeemer_wrong_pool_nft() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), pool_nft: other_nft }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// ---- output perimeter: stake-cred + reference-script pins (M-01 / L-01) ------
// Owner payouts pin payment-cred + stake=None + no ref script; the recreated pool
// and re-locked remainders pin their full address + no ref script. These block a
// solver hijacking payout staking rewards (M-01) or bloating outputs with an
// attached reference script (L-01).

const some_script = #"abababababababababababababababababababababababababababab"

// (M-01) owner payout carrying a solver-chosen stake credential: rejected (the
// payout's stake credential is pinned to None).
test settlement_owner_stake_hijack() fail {
  let owner_out = Output {
    address: Address {
      payment_credential: VerificationKey(owner_vkh),
      stake_credential: Some(Inline(Script(s_hash))),
    },
    value: assets.from_lovelace(owner_out_ada),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(True)],
    outputs: [
      owner_out,
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// (L-01) owner payout with an attached reference script: rejected.
test settlement_owner_ref_script() fail {
  let owner_out = Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(owner_out_ada),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: Some(some_script),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(True)],
    outputs: [
      owner_out,
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// (L-01) recreated pool output with an attached reference script: rejected.
test settlement_pool_ref_script() fail {
  let bad_pool = Output {
    address: tagged(Script(p_hash)),
    value: pool_val(pool_ada_in - received, pool_tok_in + sell),
    datum: InlineDatum(pool_datum()),
    reference_script: Some(some_script),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(True)],
    outputs: [owner_output(0, owner_out_ada), bad_pool, solver_output(tip)],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// (L-01) re-locked partial-fill remainder with an attached reference script:
// rejected.
test settlement_remainder_ref_script() fail {
  let bad_rem = Output {
    address: tagged(Script(o_hash)),
    value: tok_val(3_200_000, 600_000),
    datum: InlineDatum(
      OrderDatum {
        ..order_datum(),
        sell_a: True,
        sell_amount: 600_000,
        limit: 240_000,
        tip: 1_200_000,
        partial: False,
      },
    ),
    reference_script: Some(some_script),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [partial_token_order(True), pool_input(True)],
    outputs: [
      owner_output(0, 2_200_000),
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      bad_rem,
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([400_000]), tx)
}

// ---- base-address owner payout (datum-pinned stake credential) --------------
// `OrderDatum.owner_stake` lets the USER pin the payout's stake credential, so a
// settled payout can land at a BASE address (delegating/Lace-style wallets show +
// spend it). It is read FROM the order datum, so the solver still can't choose or
// redirect it — the payout address stays fully pinned (M-01 preserved). `None`
// keeps the enterprise payout (covered by every happy_n* / hijack test above).

const stake_vkh = #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"

const stake_sch = #"e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2"

// a base address: payment credential + an inline stake credential.
fn base_addr(payment: Credential, stake: Credential) -> Address {
  Address { payment_credential: payment, stake_credential: Some(Inline(stake)) }
}

// a full-fill token-seller order whose datum pins `owner_stake` for its payout.
fn order_input_stake(owner_stake: Option<Credential>) -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(order_in_ada, sell),
      datum: InlineDatum(OrderDatum { ..order_datum(), owner_stake }),
      reference_script: None,
    },
  }
}

// the single-order happy payout (owner_out_ada lovelace) at an arbitrary address.
fn payout_at(addr: Address) -> Output {
  Output {
    address: addr,
    value: assets.from_lovelace(owner_out_ada),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
}

fn build_payout(owner_stake: Option<Credential>, payout: Output) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [order_input_stake(owner_stake), pool_input(True)],
    outputs: [
      payout,
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
}

// (c) datum pins a base address (KEY stake cred); paying there is accepted.
test settlement_base_payout_key_stake_ok() {
  let stake = VerificationKey(stake_vkh)
  clearing.run(
    s(),
    redeemer([sell]),
    build_payout(
      Some(stake),
      payout_at(base_addr(VerificationKey(owner_vkh), stake)),
    ),
  )
}

// (c) a SCRIPT stake credential pinned by the datum is honored too.
test settlement_base_payout_script_stake_ok() {
  let stake = Script(stake_sch)
  clearing.run(
    s(),
    redeemer([sell]),
    build_payout(
      Some(stake),
      payout_at(base_addr(VerificationKey(owner_vkh), stake)),
    ),
  )
}

// (a) datum pins stake X but the solver pays a DIFFERENT stake Y: rejected.
test settlement_base_payout_wrong_stake() fail {
  let pinned = VerificationKey(stake_vkh)
  let other = VerificationKey(stake_sch)
  clearing.run(
    s(),
    redeemer([sell]),
    build_payout(
      Some(pinned),
      payout_at(base_addr(VerificationKey(owner_vkh), other)),
    ),
  )
}

// (a) datum pins a stake but the solver drops it (enterprise payout): rejected.
test settlement_base_payout_dropped_stake() fail {
  let pinned = VerificationKey(stake_vkh)
  clearing.run(
    s(),
    redeemer([sell]),
    build_payout(Some(pinned), payout_at(plain(VerificationKey(owner_vkh)))),
  )
}

// (self-inflicted liveness guard) an owner who pins `owner_stake == S` (the
// settlement credential) would make their OWN payout `is_tagged(S)`, so it is
// mis-classified as a phantom remainder and the settlement is rejected. The anchor
// now rejects this explicitly in `check_one` (`order.owner_stake != Some(account)`)
// rather than via the confusing `expect [] = remainders` failure. Attacker-
// uncontrollable (owner_stake is the order's own datum); the order stays reclaimable.
test settlement_base_payout_stake_eq_s_rejected() fail {
  let stake = s()
  clearing.run(
    s(),
    redeemer([sell]),
    build_payout(
      Some(stake),
      payout_at(base_addr(VerificationKey(owner_vkh), stake)),
    ),
  )
}

// (coverage, audit-machine M) the settlement keystone `assets.is_zero(tx.mint)` had
// no negative test — a regression of that single line would silently re-enable an
// unbacked LP mint/burn folded into a settlement. Pin it: a happy 1-order settlement
// carrying ANY mint is rejected (the order/payout/pool all pass first, so this
// isolates the mint guard).
test settlement_stray_mint() fail {
  let tx = Transaction {
    ..build_payout(None, payout_at(plain(VerificationKey(owner_vkh)))),
    mint: assets.from_asset(nft.policy, lp_name, 5),
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// PROPERTY (a): with the datum pinning a KEY stake, ANY script-stake payout (over
// the whole hash space) is rejected — a Script cred can never equal the pinned VK
// cred, so the pin bites for every sample (no need to dodge a hash collision).
test prop_reject_base_payout_stake(h via fuzz.bytearray_fixed(28)) fail {
  let payout = payout_at(base_addr(VerificationKey(owner_vkh), Script(h)))
  clearing.run(
    s(),
    redeemer([sell]),
    build_payout(Some(VerificationKey(stake_vkh)), payout),
  )
}

// ---- base-address payout: remainder continuity (partial fill) ---------------
// A partially-filled base-address order re-locks a remainder; the rollover must
// carry the SAME `owner_stake`, so a later settlement can't swap the payout
// delegation. Numbers mirror `partial_token_seller` (fill 400_000 of 1_000_000).

fn partial_order_stake(owner_stake: Option<Credential>) -> Input {
  Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: tok_val(tip + 2 * order_min_ada, sell),
      datum: InlineDatum(
        OrderDatum { ..order_datum(), owner_stake, partial: True },
      ),
      reference_script: None,
    },
  }
}

fn remainder_stake(owner_stake: Option<Credential>) -> Output {
  Output {
    address: tagged(Script(o_hash)),
    value: tok_val(3_200_000, 600_000),
    datum: InlineDatum(
      OrderDatum {
        ..order_datum(),
        owner_stake,
        sell_a: True,
        sell_amount: 600_000,
        limit: 240_000,
        tip: 1_200_000,
        partial: False,
      },
    ),
    reference_script: None,
  }
}

fn partial_base_tx(
  order_stake: Option<Credential>,
  rem_stake: Option<Credential>,
  payout_addr: Address,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [partial_order_stake(order_stake), pool_input(True)],
    outputs: [
      Output {
        address: payout_addr,
        value: assets.from_lovelace(2_200_000),
        datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
        reference_script: None,
      },
      pool_output(pool_ada_in - 200_000, pool_tok_in + 400_000),
      remainder_stake(rem_stake),
      solver_output(800_000),
    ],
    withdrawals: [Pair(s(), 0)],
  }
}

// (happy) partial fill of a base-address order: owner payout at the pinned base
// address, remainder carries the same stake. Accepted.
test partial_base_payout_ok() {
  let stake = VerificationKey(stake_vkh)
  clearing.run(
    s(),
    redeemer([400_000]),
    partial_base_tx(
      Some(stake),
      Some(stake),
      base_addr(VerificationKey(owner_vkh), stake),
    ),
  )
}

// (a) the remainder drops the pinned stake: rejected by the continuity pin.
test partial_remainder_wrong_stake() fail {
  let stake = VerificationKey(stake_vkh)
  clearing.run(
    s(),
    redeemer([400_000]),
    partial_base_tx(
      Some(stake),
      None,
      base_addr(VerificationKey(owner_vkh), stake),
    ),
  )
}

// ---- clearing price must be strictly positive (L-02) -----------------------
// price_num/price_den are now explicitly guarded > 0, instead of relying on
// emergent div-by-zero + the floor check.

// (L-02) zero denominator: rejected by the explicit guard (was: div-by-zero).
test settlement_price_den_zero() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), price_den: 0 }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// (L-02) zero numerator (a 0-price fill that would pay the owner nothing for a
// limit==0 order): rejected.
test settlement_price_num_zero() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), price_num: 0 }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// (L-02) negative price: rejected.
test settlement_price_negative() fail {
  let bad = SettlementRedeemer { ..redeemer([sell]), price_num: -1 }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// ---- token/token pair (neither side is ADA) -------------------------------
// asset_a = tok, asset_b = tokb; the pool's lovelace is pure min-ADA overhead.
// Order sells 1000 tok for tokb at price 3 (tokb per tok) -> 3000 tokb.

const tokb =
  AssetId {
    policy: #"888888888888888888888888888888888888888888888888888888ff",
    name: #"42",
  }

fn tt_redeemer(fills: List<Int>) -> SettlementRedeemer {
  SettlementRedeemer {
    price_num: 3,
    price_den: 1,
    asset_a: tok,
    asset_b: tokb,
    pool_nft: nft,
    fills,
  }
}

fn tt_pool_value(res_a: Int, res_b: Int, held: Int) -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(tok.policy, tok.name, res_a)
    |> assets.add(tokb.policy, tokb.name, res_b)
    |> assets.add(nft.policy, nft.name, 1)
    |> assets.add(nft.policy, lp_name, held)
}

fn tt_pool_datum() -> PoolDatum {
  PoolDatum {
    nft,
    asset_a: tok,
    asset_b: tokb,
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(owner_vkh),
  }
}

fn settlement_tt(pool_held_out: Int) -> Transaction {
  let held = total_lp - 1_000_000
  let pool_in_tt = Input {
    output_reference: pool_ref(),
    output: Output {
      address: tagged(Script(p_hash)),
      value: tt_pool_value(1_000_000, 3_000_000, held),
      datum: InlineDatum(tt_pool_datum()),
      reference_script: None,
    },
  }
  let order_in_tt = Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: assets.from_lovelace(tip + min_ada)
        |> assets.add(tok.policy, tok.name, 1000),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          owner_stake: None,
          pool_nft: nft,
          sell_a: True,
          sell_amount: 1000,
          limit: 2000,
          tip,
          partial: False,
          deadline: None,
        },
      ),
      reference_script: None,
    },
  }
  let owner_out = Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(min_ada)
      |> assets.add(tokb.policy, tokb.name, 3000),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
  let pool_out_tt = Output {
    address: tagged(Script(p_hash)),
    value: tt_pool_value(1_000_000 + 1000, 3_000_000 - 3000, pool_held_out),
    datum: InlineDatum(tt_pool_datum()),
    reference_script: None,
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [order_in_tt, pool_in_tt],
    outputs: [owner_out, pool_out_tt, solver_output(tip)],
    withdrawals: [Pair(s(), 0)],
  }
}

// token/token settlement clears and pins everything (incl. held LP): ok.
test settlement_token_token() {
  clearing.run(s(), tt_redeemer([1000]), settlement_tt(total_lp - 1_000_000))
}

// the same full-value pin guards a token/token pool's LP: strip it -> rejected.
test settlement_token_token_strip_lp() fail {
  clearing.run(s(), tt_redeemer([1000]), settlement_tt(0))
}

// ---- static trading fee in the pool k-check (§7, Option A: residual-only) --
// Pool (token/token, fee 3/1000) at reserves 1_000_000 / 1_000_000. The fee is
// charged Uniswap-v2 style on the net amount that flows INTO the pool.

fn fee_pool_value(res_a: Int, res_b: Int) -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(tok.policy, tok.name, res_a)
    |> assets.add(tokb.policy, tokb.name, res_b)
    |> assets.add(nft.policy, nft.name, 1)
}

fn fee_settle_tx(
  res_a_in: Int,
  res_b_in: Int,
  res_a_out: Int,
  res_b_out: Int,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: pool_ref(),
        output: Output {
          address: tagged(Script(p_hash)),
          value: fee_pool_value(res_a_in, res_b_in),
          datum: InlineDatum(tt_pool_datum()),
          reference_script: None,
        },
      },
    ],
    outputs: [
      Output {
        address: tagged(Script(p_hash)),
        value: fee_pool_value(res_a_out, res_b_out),
        datum: InlineDatum(tt_pool_datum()),
        reference_script: None,
      },
    ],
    withdrawals: [Pair(s(), 0)],
  }
}

// (Rev 25) pool gains 10_000 A, pays the FAIR curve amount get_amount_out(10_000, 1e6, 1e6,
// φ=0.3%) = 9_871 B (res_b_out = 990_129). No orders in this synthetic tx ⇒ n_orders=0 ⇒
// the pin requires EXACTLY fair: k grows by precisely the fee, not "past" it. (The old
// fixture paid only 9_000 B — a corridor clearing the pin now rejects; see pool_fee_corridor.)
test pool_fee_ok() {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 1_010_000, 990_129),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// same the other direction (pool gains 10_000 B, pays the fair 9_871 A): ok.
test pool_fee_reverse_ok() {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 990_129, 1_010_000),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// (Rev 25) pool gains 10_000 A but pays only 9_000 B (res_b_out=991_000) — fair is 9_871, so
// this underpays the trader by ~871 and banks it as k. Old one-sided k-check accepted it
// ("k grows past the fee"); the two-sided pin REJECTS it (n_orders=0 ⇒ zero dust band).
test pool_fee_corridor() fail {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 1_010_000, 991_000),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// pool gains 10_000 A but pays out 9_900 B: k *grows* (1.000001e12 > 1e12) yet the
// fee is NOT covered. The old zero-fee `k_out >= k_in` accepted this; now rejected.
test pool_fee_short() fail {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 1_010_000, 990_100),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// a perfectly-netted batch leaves the pool untouched: no residual, no fee -> ok.
test pool_fee_no_residual() {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 1_000_000, 1_000_000),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// ---- (Rev 25) two-sided price pin: boundary property (the make-or-break gate) --------
// For any non-degenerate token/token pool and residual `dx` (n_orders=0 via fee_settle_tx,
// so the dust band is ZERO), the pin places the pool's payout EXACTLY at the fair curve
// amount: paying `fair` passes; paying `fair − 1` (the corridor — underpay the trader) is
// REJECTED by the new lower floor; paying `fair + 1` (overpay) is REJECTED by the k-check.
// Holding across the whole fuzzed space proves the corridor is closed to ≤ the dust band,
// AND that get_amount_out is exactly the k-edge (pays_fair must also satisfy k).
fn pin_params() -> Fuzzer<(Int, Int, Int)> {
  fuzz.map3(
    fuzz.int_between(1_000_000_000, 1_000_000_000_000),
    fuzz.int_between(1_000_000_000, 1_000_000_000_000),
    fuzz.int_between(1_000_000, 100_000_000),
    fn(ra, rb, dx) { (ra, rb, dx) },
  )
}

test prop_pin_fair_boundary((ra, rb, dx) via pin_params()) {
  let fair = spend.get_amount_out(dx, ra, rb, 3, 1000)
  let pays_fair =
    spend.pool_settle(
      fee_settle_tx(ra, rb, ra + dx, rb - fair),
      pool_ref(),
      tt_pool_datum(),
      s(),
    )
  // underpay by 1 (-net_b = fair − 1): the new lower floor must reject it.
  let underpay =
    spend.pool_settle(
      fee_settle_tx(ra, rb, ra + dx, rb - fair + 1),
      pool_ref(),
      tt_pool_datum(),
      s(),
    )
  // overpay by 1 (-net_b = fair + 1): the k-check must reject it.
  let overpay =
    spend.pool_settle(
      fee_settle_tx(ra, rb, ra + dx, rb - fair - 1),
      pool_ref(),
      tt_pool_datum(),
      s(),
    )
  and {
    fair >= 1,
    pays_fair?,
    !underpay?,
    !overpay?,
  }
}

// pool pays out far too much B (k actually drops): rejected.
test pool_fee_k_drop() fail {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 1_010_000, 950_000),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// ---- property / fuzz tests (aiken/fuzz) -----------------------------------
// Build a *valid* single-order settlement from fuzzed (amount, fill, price, tip)
// using the SAME arithmetic the validator uses, and assert `clearing.run` accepts
// it across the whole input space — shaking out rounding edges in `received`, the
// proportional-tip split, and full-vs-partial branches. `owner_delta` lets a
// negative test short the owner output by 1 (every sample must then be rejected).
// Pair convention: asset_a = tok, asset_b = ada; limit = 0 (market) decouples the
// floor so the fuzz targets value/rounding, not the (already unit-tested) floor.

fn params() -> Fuzzer<(Int, Int, Int, Int, Int)> {
  fuzz.map5(
    fuzz.int_between(1, 1_000_000),
    fuzz.int_between(1, 1_000_000),
    fuzz.int_between(1, 1000),
    fuzz.int_between(1, 1000),
    fuzz.int_between(1, 10_000_000),
    fn(a, b, c, d, e) { (a, b, c, d, e) },
  )
}

// token-seller (sells asset_a = tok, buys asset_b = ada)
fn ts_settlement(
  sell_amount: Int,
  f: Int,
  pn: Int,
  pd: Int,
  tip: Int,
  owner_delta: Int,
) -> Transaction {
  let received = f * pn / pd
  let is_partial = f < sell_amount
  let tip_taken = tip * f / sell_amount
  let tip_rem = tip - tip_taken
  let unsold = sell_amount - f
  let m = order_min_ada
  let order_in = Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: assets.from_lovelace(tip + 2 * m)
        |> assets.add(tok.policy, tok.name, sell_amount),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          owner_stake: None,
          pool_nft: nft,
          sell_a: True,
          sell_amount,
          limit: 0,
          tip,
          partial: True,
          deadline: None,
        },
      ),
      reference_script: None,
    },
  }
  let owner_ada = if is_partial {
    m + received
  } else {
    2 * m + received
  }
  let owner_out = Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(owner_ada + owner_delta),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
  let pool_out = pool_output(pool_ada_in - received, pool_tok_in + f)
  let outs = if is_partial {
    [
      owner_out,
      pool_out,
      Output {
        address: tagged(Script(o_hash)),
        value: assets.from_lovelace(m + tip_rem)
          |> assets.add(tok.policy, tok.name, unsold),
        datum: InlineDatum(
          OrderDatum {
            owner: VerificationKey(owner_vkh),
            owner_stake: None,
            pool_nft: nft,
            sell_a: True,
            sell_amount: unsold,
            limit: 0,
            tip: tip_rem,
            partial: False,
            deadline: None,
          },
        ),
        reference_script: None,
      },
    ]
  } else {
    [owner_out, pool_out]
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [order_in, pool_input(True)],
    outputs: outs,
    withdrawals: [Pair(s(), 0)],
  }
}

// ADA-seller (sells asset_b = ada, buys asset_a = tok)
fn as_settlement(
  sell_amount: Int,
  f: Int,
  pn: Int,
  pd: Int,
  tip: Int,
  owner_delta: Int,
) -> Transaction {
  let received = f * pd / pn
  let is_partial = f < sell_amount
  let tip_taken = tip * f / sell_amount
  let tip_rem = tip - tip_taken
  let unsold = sell_amount - f
  let m = order_min_ada
  let order_in = Input {
    output_reference: order_ref(0),
    output: Output {
      address: tagged(Script(o_hash)),
      value: assets.from_lovelace(sell_amount + tip + 2 * m),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          owner_stake: None,
          pool_nft: nft,
          sell_a: False,
          sell_amount,
          limit: 0,
          tip,
          partial: True,
          deadline: None,
        },
      ),
      reference_script: None,
    },
  }
  let owner_ada = if is_partial {
    m
  } else {
    2 * m
  }
  let owner_out = Output {
    address: plain(VerificationKey(owner_vkh)),
    value: assets.from_lovelace(owner_ada + owner_delta)
      |> assets.add(tok.policy, tok.name, received),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
  let pool_out = pool_output(pool_ada_in + f, pool_tok_in - received)
  let outs = if is_partial {
    [
      owner_out,
      pool_out,
      Output {
        address: tagged(Script(o_hash)),
        value: assets.from_lovelace(m + tip_rem + unsold),
        datum: InlineDatum(
          OrderDatum {
            owner: VerificationKey(owner_vkh),
            owner_stake: None,
            pool_nft: nft,
            sell_a: False,
            sell_amount: unsold,
            limit: 0,
            tip: tip_rem,
            partial: False,
            deadline: None,
          },
        ),
        reference_script: None,
      },
    ]
  } else {
    [owner_out, pool_out]
  }
  Transaction {
    ..transaction.placeholder,
    inputs: [order_in, pool_input(True)],
    outputs: outs,
    withdrawals: [Pair(s(), 0)],
  }
}

fn fuzz_redeemer(pn: Int, pd: Int, f: Int) -> SettlementRedeemer {
  SettlementRedeemer {
    price_num: pn,
    price_den: pd,
    asset_a: tok,
    asset_b: ada,
    pool_nft: nft,
    fills: [f],
  }
}

// PROPERTY: any valid token-seller settlement (random amount/price/fill/tip) clears.
test prop_token_seller(p via params()) {
  let (sell_amount, fill_raw, pn, pd, tip) = p
  let f = if fill_raw > sell_amount {
    sell_amount
  } else {
    fill_raw
  }
  clearing.run(
    s(),
    fuzz_redeemer(pn, pd, f),
    ts_settlement(sell_amount, f, pn, pd, tip, 0),
  )
}

// PROPERTY: any valid ADA-seller settlement clears.
test prop_ada_seller(p via params()) {
  let (sell_amount, fill_raw, pn, pd, tip) = p
  let f = if fill_raw > sell_amount {
    sell_amount
  } else {
    fill_raw
  }
  clearing.run(
    s(),
    fuzz_redeemer(pn, pd, f),
    as_settlement(sell_amount, f, pn, pd, tip, 0),
  )
}

// PROPERTY (tightness): shorting the owner output by 1 lovelace is ALWAYS rejected,
// for every amount/price/fill/tip — the owner pin is exact across the whole space.
test prop_token_seller_short_owner(p via params()) fail {
  let (sell_amount, fill_raw, pn, pd, tip) = p
  let f = if fill_raw > sell_amount {
    sell_amount
  } else {
    fill_raw
  }
  clearing.run(
    s(),
    fuzz_redeemer(pn, pd, f),
    ts_settlement(sell_amount, f, pn, pd, tip, -1),
  )
}

// ---- adversarial property tests over the solver's degrees of freedom (I-02) ---
// The fixtures above are stuck-at-default for the fields a solver actually controls
// (declared pair, output stake credential, output reference script). These fuzz
// those degrees of freedom and assert the hardened anchor rejects the whole space —
// so a regression on C-01/C-02 (binding), M-01 (stake pin), or L-01 (ref-script
// pin) is caught, not just the single hand-built sample.

// a non-empty policy id (1..28 bytes) — anything here differs from the pool's real
// asset_b (ADA = empty policy), and includes the pool's own policy as a sub-case.
fn nonempty_policy() -> Fuzzer<ByteArray> {
  fuzz.bytearray_between(1, 28)
}

// PROPERTY (C-01/C-02): any asset_b with a non-empty policy (≠ the pool's bound
// asset_b = ADA) is rejected — the redeemer pair is pinned to the PoolDatum. This
// space includes asset_b under the pool's own policy (the C-01 LP/NFT alias).
test prop_reject_foreign_asset_b(pol via nonempty_policy()) fail {
  let bad = SettlementRedeemer {
    ..redeemer([sell]),
    asset_b: AssetId { policy: pol, name: #"4c50" },
  }
  clearing.run(
    s(),
    bad,
    build1(owner_out_ada, 0, pool_ada_in - received, pool_tok_in + sell, True),
  )
}

// PROPERTY (C-02): any order consenting to a pool_nft other than the settled one is
// rejected — fuzz the order's target NFT policy across the whole non-matching space.
test prop_reject_order_wrong_pool(pol via nonempty_policy()) fail {
  let other = AssetId { policy: pol, name: #"4e4654" }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input_pool(other), pool_input(True)],
    outputs: [
      owner_output(0, owner_out_ada),
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// PROPERTY (M-01): any owner payout carrying a stake credential (the solver's choice)
// is rejected — the payout's stake credential is pinned to None across the space.
test prop_reject_owner_stake(h via fuzz.bytearray_fixed(28)) fail {
  let owner_out = Output {
    address: Address {
      payment_credential: VerificationKey(owner_vkh),
      stake_credential: Some(Inline(VerificationKey(h))),
    },
    value: assets.from_lovelace(owner_out_ada),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(0) }),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(True)],
    outputs: [
      owner_out,
      pool_output(pool_ada_in - received, pool_tok_in + sell),
      solver_output(tip),
    ],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// PROPERTY (L-01): any reference script attached to the recreated pool output is
// rejected across the whole script-hash space.
test prop_reject_pool_ref_script(h via fuzz.bytearray_fixed(28)) fail {
  let bad_pool = Output {
    address: tagged(Script(p_hash)),
    value: pool_val(pool_ada_in - received, pool_tok_in + sell),
    datum: InlineDatum(pool_datum()),
    reference_script: Some(h),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [order_input(0, True), pool_input(True)],
    outputs: [owner_output(0, owner_out_ada), bad_pool, solver_output(tip)],
    withdrawals: [Pair(s(), 0)],
  }
  clearing.run(s(), redeemer([sell]), tx)
}

// ---- benchmarks: settlement hot path (I-01) --------------------------------
// Baseline ex-unit measurements for the once-per-tx settlement anchor, the cost
// that bounds the batch-size ceiling (BLUEPRINT §13.1, ~40-50 orders). The tx is
// built inside the Sampler (generation phase, not measured), so the body measures
// only `clearing.run`. Run: `aiken bench` (raise the ceiling with --max-size 50).

// Sampler: an N-order happy settlement (N = bench size, clamped to >= 1).
fn settlement_of_size(n0: Int) -> Fuzzer<(SettlementRedeemer, Transaction)> {
  let n = if n0 < 1 {
    1
  } else {
    n0
  }
  fuzz.constant((redeemer(list.repeat(sell, n)), build(n)))
}

bench settlement__run(p via settlement_of_size) {
  let (r, tx) = p
  clearing.run(s(), r, tx)
}

// Fixed-shape benches (size is irrelevant): the prepared tx is built in the
// Sampler (generation phase), so the body measures only the lib function.
fn one_order_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(build(1))
}

bench pool__pool_settle(tx via one_order_tx) {
  spend.pool_settle(tx, pool_ref(), pool_datum(), s())
}

bench order__order_settle(tx via one_order_tx) {
  spend.order_settle(tx, order_ref(0), s())
}

// cold path: owner reclaim (audit I-04).
fn reclaim_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    Transaction { ..transaction.placeholder, extra_signatories: [owner_vkh] },
  )
}

bench order__order_reclaim(tx via reclaim_tx) {
  spend.order_reclaim(VerificationKey(owner_vkh), tx)
}
