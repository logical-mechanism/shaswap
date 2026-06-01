//// Tests for the production settlement anchor + order/pool validators (Rev 6).
//// Synthesises settlements with the stake-credential-tag wiring and checks the
//// §5.2 guarantees hold (happy path) and the §5.4/§8 safety properties bite
//// (floor breach, mis-binding, value theft, fake pool, untagged smuggle, k drop).

use aiken/collection/list
use aiken/interval.{Interval}
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use shaswap/clearing
use shaswap/constants.{order_min_ada}
use shaswap/spend
use shaswap/types.{
  AssetId, BoundDatum, OrderDatum, PoolDatum, PoolSettle, Reclaim, Settle,
  SettlementRedeemer,
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
    token: tok,
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
    sell_ada: False,
    sell_amount: sell,
    limit,
    tip,
    partial: False,
    deadline: None,
  }
}

fn pool_datum() -> PoolDatum {
  PoolDatum { nft, token: tok, fee_num: 3, fee_den: 1000 }
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

// ADA-seller: sells `sell_ada_amt` lovelace, buys token (limit `lim` token).
fn ada_order_input(i: Int, sell_ada_amt: Int, lim: Int) -> Input {
  Input {
    output_reference: order_ref(i),
    output: Output {
      address: tagged(Script(o_hash)),
      value: assets.from_lovelace(sell_ada_amt + tip + min_ada),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          sell_ada: True,
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
          sell_ada: False,
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
          sell_ada: True,
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
  ada: Int,
  sell2: Int,
  lim2: Int,
  tip2: Int,
) -> Output {
  Output {
    address: tagged(Script(o_hash)),
    value: tok_val(ada, tok_amt),
    datum: InlineDatum(
      OrderDatum {
        owner: VerificationKey(owner_vkh),
        sell_ada: is_ada,
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
