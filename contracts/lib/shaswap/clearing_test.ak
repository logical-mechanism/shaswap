//// Tests for the production settlement anchor + order/pool validators (Rev 6).
//// Synthesises settlements with the stake-credential-tag wiring and checks the
//// §5.2 guarantees hold (happy path) and the §5.4/§8 safety properties bite
//// (floor breach, mis-binding, value theft, fake pool, untagged smuggle, k drop).

use aiken/collection/list
use aiken/fuzz
use aiken/interval.{Interval}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use shaswap/clearing
use shaswap/constants.{lp_name, order_min_ada, total_lp}
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

// ---- pool validator logic (owns k) ----------------------------------------

test pool_settle_ok() {
  spend.pool_settle(build(1), pool_ref(), pool_datum(), s())
}

// k decreases (pool pays out ADA without gaining token): rejected.
test pool_settle_k_drop() fail {
  let tx = build1(owner_out_ada, 0, pool_ada_in - 2_000_000, pool_tok_in, True)
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

// pool gains 10_000 A, pays out 9_000 B: k grows well past the 0.3% fee -> ok.
test pool_fee_ok() {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 1_010_000, 991_000),
    pool_ref(),
    tt_pool_datum(),
    s(),
  )
}

// same the other direction (pool gains 10_000 B, pays 9_000 A): ok.
test pool_fee_reverse_ok() {
  spend.pool_settle(
    fee_settle_tx(1_000_000, 1_000_000, 991_000, 1_010_000),
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
