//// The curve-agnostic settlement check (BLUEPRINT §5.2/§5.4), run once per tx by
//// the unparameterised withdraw-0 settlement validator.
////
//// Enumerates the protocol input set by the stake-credential tag `S`, classifies
//// each tagged input by datum shape (parses-as-OrderDatum => order; the sole
//// non-order => the pool), and enforces uniform price, per-order floor, the
//// injective O(N) positional order->output binding, deadlines, and partial fills.
//// Orders are **bidirectional**: token->ADA and ADA->token orders clear at one
//// price and **net** against each other; only the residual hits the pool.
////
//// **Partial fills (proportional tip).** The solver declares each order's fill
//// `f` in `redeemer.fills`. `f == sell_amount` is a full fill (owner output only).
//// `f < sell_amount` requires `partial == True` and produces a **remainder UTXO**
//// re-locked at the order's own address (tagged `S`, `partial == False` — one
//// level) holding the unsold asset + a pre-funded min-ADA + the leftover tip
//// `tip − tip·f/sell`; the solver collects `tip·f/sell` now. The pre-funded second
//// min-ADA (which on a full fill simply returns to the owner) funds the remainder.
////
//// It does NOT check `k` (pool validator's job, §5.4) and never parses PoolDatum.
//// Safety without a global-conservation pass: every owner output, every remainder,
//// and the pool are pinned exactly, `mint == 0`, and ledger value conservation then
//// forces the solver to take only the (proportional) tips.

use aiken/collection/list
use aiken/interval.{Finite, Interval}
use cardano/address.{Credential}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use shaswap/constants.{order_min_ada}
use shaswap/types.{BoundDatum, OrderDatum, SettlementRedeemer}
use shaswap/utils

fn parses_as_order(i: Input) -> Bool {
  when i.output.datum is {
    InlineDatum(d) ->
      if d is _o: OrderDatum {
        True
      } else {
        False
      }
    _ -> False
  }
}

/// The tx's finite upper validity bound, if any (None if open-ended).
fn finite_upper(range: Interval) -> Option<Int> {
  when range.upper_bound.bound_type is {
    Finite(u) -> Some(u)
    _ -> None
  }
}

/// An order with a deadline can only be settled while the tx is bounded to end
/// no later than the deadline (an open-ended tx can't honor it).
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

/// Verify and consume the head remainder UTXO for a partially-filled order. It
/// must sit at the order's own address (so it stays a reclaimable order tagged
/// `S`), hold exactly the unsold asset + pre-funded min-ADA + leftover tip, and
/// carry a one-level (`partial == False`) order datum that preserves the owner,
/// direction, deadline, and the limit *price* (`limit'·sell ≥ limit·sell'`).
fn consume_remainder(
  remainders: List<Output>,
  order: OrderDatum,
  new_sell: Int,
  tip_rem: Int,
  exp_tok: Int,
  exp_ada: Int,
  order_addr,
  r: SettlementRedeemer,
) -> List<Output> {
  expect [rem, ..rest] = remainders
  expect rem.address == order_addr
  expect assets.lovelace_of(rem.value) == exp_ada
  expect utils.asset_qty(rem.value, r.token) == exp_tok
  expect InlineDatum(rd) = rem.datum
  expect ro: OrderDatum = rd
  expect ro.owner == order.owner
  expect ro.sell_ada == order.sell_ada
  expect ro.sell_amount == new_sell
  expect ro.tip == tip_rem
  expect !ro.partial
  expect ro.deadline == order.deadline
  // limit price preserved or improved (never fills worse than the original)
  expect ro.limit * order.sell_amount >= order.limit * new_sell
  rest
}

/// Per-order check at the uniform price. Returns the order's signed contribution
/// to the pool's net reserve movement `(d_token, d_ada)` and the remainders list
/// with this order's remainder (if partial) consumed.
fn check_one(
  input: Input,
  bound: Output,
  f: Int,
  remainders: List<Output>,
  r: SettlementRedeemer,
  tx_upper: Option<Int>,
) -> (Int, Int, List<Output>) {
  expect InlineDatum(od) = input.output.datum
  expect order: OrderDatum = od

  expect deadline_ok(order.deadline, tx_upper)
  // (6) injective binding: this output is bound to THIS order's unique ref
  expect InlineDatum(bd) = bound.datum
  expect b: BoundDatum = bd
  expect b.order_ref == input.output_reference
  expect bound.address.payment_credential == order.owner

  expect f >= 1
  expect f <= order.sell_amount
  let is_partial = f < order.sell_amount
  // partial fills require the order to allow them
  expect or {
      !is_partial,
      order.partial,
    }

  let in_ada = assets.lovelace_of(input.output.value)
  let in_tok = utils.asset_qty(input.output.value, r.token)
  let out_ada = assets.lovelace_of(bound.value)
  let out_tok = utils.asset_qty(bound.value, r.token)
  let unsold = order.sell_amount - f
  // proportional tip: solver takes tip·f/sell now, remainder keeps the rest
  let tip_rem = order.tip - order.tip * f / order.sell_amount

  if order.sell_ada {
    // sells ADA, buys token at 1/p = den/num
    let received = f * r.price_den / r.price_num
    // (5) per-order floor = limit price honored (full-fill floor, any f)
    expect order.sell_amount * r.price_den >= order.limit * r.price_num
    expect in_tok == 0
    expect out_tok == received
    if is_partial {
      // owner keeps one min-ADA; the other pre-funded min-ADA funds the remainder
      expect out_ada == in_ada - order.sell_amount - order.tip - order_min_ada
      let rest = consume_remainder(
        remainders,
        order,
        unsold,
        tip_rem,
        0,
        unsold + order_min_ada + tip_rem,
        input.output.address,
        r,
      )
      (-received, f, rest)
    } else {
      expect out_ada == in_ada - order.sell_amount - order.tip
      (-received, order.sell_amount, remainders)
    }
  } else {
    // sells token, buys ADA at p = num/den
    let received = f * r.price_num / r.price_den
    expect order.sell_amount * r.price_num >= order.limit * r.price_den
    expect in_tok == order.sell_amount
    expect out_tok == 0
    if is_partial {
      expect out_ada == in_ada - order.tip + received - order_min_ada
      let rest = consume_remainder(
        remainders,
        order,
        unsold,
        tip_rem,
        unsold,
        order_min_ada + tip_rem,
        input.output.address,
        r,
      )
      (f, -received, rest)
    } else {
      expect out_ada == in_ada - order.tip + received
      (order.sell_amount, -received, remainders)
    }
  }
}

/// Process every order (zipped with its owner output and fill), threading the
/// remainders list. Returns the pool's net `(token, ada)` movement; asserts that
/// fills and remainders are exactly consumed (no extras).
fn process(
  pairs: List<(Input, Output)>,
  fills: List<Int>,
  remainders: List<Output>,
  r: SettlementRedeemer,
  tx_upper: Option<Int>,
) -> (Int, Int) {
  when pairs is {
    [] -> {
      expect [] = fills
      expect [] = remainders
      (0, 0)
    }
    [(input, bound), ..rest] -> {
      expect [f, ..frest] = fills
      let (d_tok, d_ada, rem2) = check_one(
        input,
        bound,
        f,
        remainders,
        r,
        tx_upper,
      )
      let (t, a) = process(rest, frest, rem2, r, tx_upper)
      (d_tok + t, d_ada + a)
    }
  }
}

pub fn run(account: Credential, r: SettlementRedeemer, tx: Transaction) -> Bool {
  // (7) enumerate the protocol input set by the stake tag S = our own credential
  let tagged_inputs = list.filter(
    tx.inputs,
    fn(i) { utils.is_tagged(i.output, account) },
  )

  // orders parse as OrderDatum; the sole non-order tagged input is the pool. A
  // real order can never be mis-roled as the pool (§5.4).
  let (order_inputs, pool_inputs) = list.partition(
    tagged_inputs,
    parses_as_order,
  )
  expect [pool_in] = pool_inputs

  expect utils.asset_qty(pool_in.output.value, r.pool_nft) == 1
  let r_ada_in = assets.lovelace_of(pool_in.output.value)
  let r_tok_in = utils.asset_qty(pool_in.output.value, r.token)

  // tagged outputs = the pool (carries the NFT) + remainder UTXOs (no NFT).
  let tagged_outputs = list.filter(
    tx.outputs,
    fn(o) { utils.is_tagged(o, account) },
  )
  let (pool_outs, remainders) = list.partition(
    tagged_outputs,
    fn(o) { utils.asset_qty(o.value, r.pool_nft) == 1 },
  )
  expect [pool_out] = pool_outs
  expect pool_out.address == pool_in.output.address
  let r_ada_out = assets.lovelace_of(pool_out.value)
  let r_tok_out = utils.asset_qty(pool_out.value, r.token)

  // (6) O(N) positional binding: owner-outputs are the first N outputs in
  // canonical (input) order; remainders follow the pool.
  let n = list.length(order_inputs)
  let owner_outputs = list.take(tx.outputs, n)
  expect list.length(owner_outputs) == n
  let tx_upper = finite_upper(tx.validity_range)
  let (net_tok, net_ada) = process(
    list.zip(order_inputs, owner_outputs),
    r.fills,
    remainders,
    r,
    tx_upper,
  )

  // no minting/burning in a settlement (LP mint only at create/close)
  expect assets.is_zero(tx.mint)

  // (1) the pool absorbs EXACTLY the net residual; pinning it (plus per-order and
  // per-remainder pinning) forces the solver to take only the proportional tips
  // via ledger conservation — no separate global-conservation pass needed.
  expect r_tok_out == r_tok_in + net_tok
  expect r_ada_out == r_ada_in + net_ada

  // NB: k_after >= k_before is enforced by the POOL validator (§5.4 split).
  True
}
