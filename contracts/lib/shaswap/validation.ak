//// Core §5.2 settlement checks for the spike. Two variants of the
//// order->output binding (the suspected O(N^2) hot spot) share every other
//// check via `finish`, so the measured delta between them isolates the binding
//// cost.
////
////   - `validate_naive`   : for each order, scan ALL outputs for its bound
////                          output (O(N^2)).
////   - `validate_indexed` : owner-outputs must occupy the first N output
////                          positions in input order; zip positionally (O(N)).
////
//// Both enforce, over the whole batch (BLUEPRINT §5.2):
////   1. asset conservation (X and ADA), ADA's three roles kept separate,
////   2. one uniform clearing price for every order,
////   3. pool invariant k non-decreasing, from ACTUAL reserves,
////   4. best-response per order at the clearing price,
////   5. per-order floor (received >= the order's own limit),
////   6. injective order->output binding (no double satisfaction),
////   7. EVERY script input accounted for — none slips past.

use aiken/collection/list
use cardano/address.{Address, Credential, Script}
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use shaswap/config
use shaswap/types.{BoundDatum, OrderDatum, SettlementRedeemer}

// ---------------------------------------------------------------------------
// order-side O(1) deferral (BLUEPRINT §5.4)
//
// The order validator does NOT re-run §5.2 per input; it only checks that the
// once-per-tx settlement withdrawal is present. This runs once PER ORDER INPUT
// on-chain, so its cost is multiplied by N in the tx budget. Lives here so the
// spike can measure it (validators can't be imported cross-module in Aiken).
// ---------------------------------------------------------------------------

pub fn settlement_present(tx: Transaction) -> Bool {
  list.any(tx.withdrawals, fn(p) { p.1st == Script(config.settlement_hash) })
}

// ---------------------------------------------------------------------------
// classification helpers
// ---------------------------------------------------------------------------

fn cred_of(input: Input) -> Credential {
  input.output.address.payment_credential
}

fn is_script(input: Input) -> Bool {
  when cred_of(input) is {
    Script(_) -> True
    _ -> False
  }
}

fn is_order(input: Input) -> Bool {
  cred_of(input) == Script(config.order_hash)
}

fn is_pool_in(input: Input) -> Bool {
  cred_of(input) == Script(config.pool_hash)
}

fn is_pool_out(output: Output) -> Bool {
  output.address.payment_credential == Script(config.pool_hash)
}

fn x_of(v: Value) -> Int {
  assets.quantity_of(v, config.token_policy, config.token_name)
}

// ---------------------------------------------------------------------------
// per-order checks (shared by both variants)
//
// `received` is computed from the UNIFORM clearing price and then the bound
// owner-output is required to equal (min-ada carried) + received, with the tip
// removed. This pins ADA's three roles:
//   traded-ADA = `received` (pool -> owner), min-ADA preserved per UTXO,
//   tip-ADA = order -> solver (never in the owner output).
// Returns (sold, received, tip) to accumulate; aborts on any violation.
// ---------------------------------------------------------------------------

fn check_order(
  order: OrderDatum,
  order_in_lovelace: Int,
  bound: Output,
  num: Int,
  den: Int,
) -> (Int, Int, Int) {
  // best-response at the uniform price (integer floor division — no floats)
  let received = order.sell_amount * num / den
  // per-order floor: never worse than the order's own stated limit
  expect received >= order.limit
  // owner-output goes to the order's owner
  expect bound.address.payment_credential == order.owner
  // ADA role separation: owner keeps its min-ada, gains exactly `received`,
  // and the tip is gone (it goes to the solver).
  expect
    assets.lovelace_of(bound.value) == order_in_lovelace - order.tip + received
  // owner-output carries no token X (it bought ADA)
  expect x_of(bound.value) == 0
  (order.sell_amount, received, order.tip)
}

fn read_order(input: Input) -> (OrderDatum, Int) {
  expect InlineDatum(d) = input.output.datum
  expect order: OrderDatum = d
  (order, assets.lovelace_of(input.output.value))
}

// ---------------------------------------------------------------------------
// binding variant A — naive O(N^2): scan all outputs per order
// ---------------------------------------------------------------------------

fn bind_naive(input: Input, outputs: List<Output>) -> Output {
  let oref = input.output_reference
  expect Some(bound) = list.find(
    outputs,
    fn(o) {
      when o.datum is {
        InlineDatum(bd) ->
          if bd is b: BoundDatum {
            b.order_ref == oref
          } else {
            False
          }
        _ -> False
      }
    },
  )
  bound
}

fn process_naive(
  orders: List<Input>,
  outputs: List<Output>,
  num: Int,
  den: Int,
) -> (Int, Int, Int) {
  list.foldl(
    orders,
    (0, 0, 0),
    fn(input, acc) {
      let (ss, sr, st) = acc
      let (order, in_lovelace) = read_order(input)
      let bound = bind_naive(input, outputs)
      let (sold, recv, tip) = check_order(order, in_lovelace, bound, num, den)
      (ss + sold, sr + recv, st + tip)
    },
  )
}

// ---------------------------------------------------------------------------
// binding variant B — indexed O(N): positional bijection
//
// Owner-outputs must be the first N outputs, in the same order as the order
// inputs (ledger-canonical: ascending OutputReference). Position gives
// injectivity for free; we still read each BoundDatum.order_ref to confirm the
// canonical pairing is the one the solver claims.
// ---------------------------------------------------------------------------

fn check_bound_ref(bound: Output, oref) -> Bool {
  expect InlineDatum(bd) = bound.datum
  expect b: BoundDatum = bd
  b.order_ref == oref
}

fn process_indexed(
  orders: List<Input>,
  owner_outputs: List<Output>,
  num: Int,
  den: Int,
) -> (Int, Int, Int) {
  list.foldl(
    list.zip(orders, owner_outputs),
    (0, 0, 0),
    fn(pair, acc) {
      let (ss, sr, st) = acc
      let (input, bound) = pair
      let (order, in_lovelace) = read_order(input)
      // confirm the positional pairing matches the order's unique ref
      expect check_bound_ref(bound, input.output_reference)
      let (sold, recv, tip) = check_order(order, in_lovelace, bound, num, den)
      (ss + sold, sr + recv, st + tip)
    },
  )
}

// ---------------------------------------------------------------------------
// shared batch-level finish: input accounting, conservation, pool invariant
// ---------------------------------------------------------------------------

fn finish(
  tx: Transaction,
  order_inputs: List<Input>,
  sums: (Int, Int, Int),
) -> Bool {
  let (sum_sold, sum_received, _sum_tip) = sums

  // (7) account for EVERY script input — none may slip past the once-per-tx
  // validator. Every script input must be an order or the single pool input.
  let n_orders = list.length(order_inputs)
  let n_script = list.count(tx.inputs, is_script)
  expect n_script == n_orders + 1

  // exactly one pool input and one pool output
  expect [pool_in] = list.filter(tx.inputs, is_pool_in)
  expect [pool_out] = list.filter(tx.outputs, is_pool_out)

  // (1) global asset conservation: nothing minted/burned (no LP move here)
  expect assets.is_zero(tx.mint)
  let in_ada = list.foldl(
    tx.inputs,
    0,
    fn(i, a) { a + assets.lovelace_of(i.output.value) },
  )
  let out_ada = list.foldl(
    tx.outputs,
    0,
    fn(o, a) { a + assets.lovelace_of(o.value) },
  )
  let in_x = list.foldl(tx.inputs, 0, fn(i, a) { a + x_of(i.output.value) })
  let out_x = list.foldl(tx.outputs, 0, fn(o, a) { a + x_of(o.value) })
  expect in_ada == out_ada
  expect in_x == out_x

  // pool reserves from ACTUAL value (k never stored)
  let r_ada_in = assets.lovelace_of(pool_in.output.value)
  let r_x_in = x_of(pool_in.output.value)
  let r_ada_out = assets.lovelace_of(pool_out.value)
  let r_x_out = x_of(pool_out.value)

  // (1) traded-ADA role: the pool pays out exactly the traded ADA, and gains
  // exactly the sold X — tips/min-ADA never leak into the pool.
  expect r_x_out == r_x_in + sum_sold
  expect r_ada_out == r_ada_in - sum_received

  // (3) pool invariant non-decreasing, from actual reserves
  r_ada_out * r_x_out >= r_ada_in * r_x_in
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

pub fn validate_naive(redeemer: SettlementRedeemer, tx: Transaction) -> Bool {
  let order_inputs = list.filter(tx.inputs, is_order)
  let sums = process_naive(
    order_inputs,
    tx.outputs,
    redeemer.price_num,
    redeemer.price_den,
  )
  finish(tx, order_inputs, sums)
}

pub fn validate_indexed(redeemer: SettlementRedeemer, tx: Transaction) -> Bool {
  let order_inputs = list.filter(tx.inputs, is_order)
  let n = list.length(order_inputs)
  // canonical: owner-outputs are the first N outputs (pool + solver follow)
  let owner_outputs = list.take(tx.outputs, n)
  let sums = process_indexed(
    order_inputs,
    owner_outputs,
    redeemer.price_num,
    redeemer.price_den,
  )
  finish(tx, order_inputs, sums)
}
