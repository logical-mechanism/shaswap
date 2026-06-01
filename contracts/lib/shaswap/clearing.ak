//// The curve-agnostic settlement check (BLUEPRINT §5.2/§5.4), run once per tx by
//// the unparameterised withdraw-0 settlement validator.
////
//// Enumerates the protocol input set by the stake-credential tag `S` (= the
//// withdraw purpose's own credential), classifies each tagged input by datum
//// shape (parses-as-OrderDatum => order; the sole non-order => the pool), and
//// enforces uniform price, per-order floor, and the injective O(N) positional
//// order->output binding. Orders are **bidirectional**: token->ADA and ADA->token
//// orders clear at one price and **net** against each other; only the residual
//// hits the pool (the batch-auction benefit).
////
//// It does NOT check `k` — the pool validator's job (§5.4 split) — and never
//// parses the PoolDatum, so it stays curve-agnostic. Safety without an explicit
//// global-conservation pass: every order's *sold* asset and *both* owner-output
//// assets are pinned exactly, the pool's reserve movement is pinned to the net,
//// `mint == 0`, and the ledger's own value conservation then forces the solver to
//// take exactly the tips (it cannot skim). That also drops two O(N) folds.

use aiken/collection/list
use aiken/interval.{Finite, Interval}
use cardano/address.{Credential}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
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

/// Per-order checks at the uniform clearing price `p = price_num/price_den`
/// (ADA per token). Returns this order's signed contribution to the pool's net
/// reserve movement `(d_token_to_pool, d_ada_to_pool)`. Aborts on any violation
/// (default-deny). `bound` is the positionally-paired owner-output.
fn check_order(
  input: Input,
  bound: Output,
  r: SettlementRedeemer,
  tx_upper: Option<Int>,
) -> (Int, Int) {
  expect InlineDatum(od) = input.output.datum
  expect order: OrderDatum = od
  let in_ada = assets.lovelace_of(input.output.value)
  let in_tok = utils.asset_qty(input.output.value, r.token)
  let out_ada = assets.lovelace_of(bound.value)
  let out_tok = utils.asset_qty(bound.value, r.token)

  // settlement must land before the order's deadline (if any)
  expect deadline_ok(order.deadline, tx_upper)
  // (6) injective binding: this output is bound to THIS order's unique ref
  expect InlineDatum(bd) = bound.datum
  expect b: BoundDatum = bd
  expect b.order_ref == input.output_reference
  // owner-output goes to the owner
  expect bound.address.payment_credential == order.owner

  if order.sell_ada {
    // sells `sell_amount` lovelace, buys token at 1/p = den/num
    let received = order.sell_amount * r.price_den / r.price_num
    expect received >= order.limit
    // order carries no token; owner gets exactly `received` token and keeps its
    // min-ADA (input ADA minus the sold ADA minus the tip).
    expect in_tok == 0
    expect out_tok == received
    expect out_ada == in_ada - order.sell_amount - order.tip
    // pool gains the sold ADA, gives out the bought token
    (-received, order.sell_amount)
  } else {
    // sells `sell_amount` token, buys ADA at p = num/den
    let received = order.sell_amount * r.price_num / r.price_den
    expect received >= order.limit
    // order carries exactly the token it sells (no excess to skim); owner gets
    // its min-ADA back plus `received` ADA, and no token.
    expect in_tok == order.sell_amount
    expect out_tok == 0
    expect out_ada == in_ada - order.tip + received
    // pool gains the sold token, pays out the bought ADA
    (order.sell_amount, -received)
  }
}

fn process_orders(
  orders: List<Input>,
  owner_outputs: List<Output>,
  r: SettlementRedeemer,
  tx_upper: Option<Int>,
) -> (Int, Int) {
  list.foldl(
    list.zip(orders, owner_outputs),
    (0, 0),
    fn(pair, acc) {
      let (tok_acc, ada_acc) = acc
      let (input, bound) = pair
      let (d_tok, d_ada) = check_order(input, bound, r, tx_upper)
      (tok_acc + d_tok, ada_acc + d_ada)
    },
  )
}

pub fn run(account: Credential, r: SettlementRedeemer, tx: Transaction) -> Bool {
  // (7) enumerate the protocol input set by the stake tag S = our own credential
  let tagged_inputs = list.filter(
    tx.inputs,
    fn(i) { utils.is_tagged(i.output, account) },
  )

  // role identification: orders parse as OrderDatum; the sole non-order is the
  // pool. A real order can never be mis-roled as the pool (it parses as order),
  // closing the relabel-and-drain deferral path (§5.4).
  let (order_inputs, pool_inputs) = list.partition(
    tagged_inputs,
    parses_as_order,
  )
  expect [pool_in] = pool_inputs

  // pool input carries the declared NFT (qty 1); reserves from value (k unread)
  expect utils.asset_qty(pool_in.output.value, r.pool_nft) == 1
  let r_ada_in = assets.lovelace_of(pool_in.output.value)
  let r_tok_in = utils.asset_qty(pool_in.output.value, r.token)

  // pool output: the single tagged output, recreated at the pool's address with
  // the NFT (continuity). v1 full-fill => exactly one tagged output; partial-fill
  // remainders (also tagged) are a later milestone.
  expect [pool_out] = list.filter(
    tx.outputs,
    fn(o) { utils.is_tagged(o, account) },
  )
  expect pool_out.address == pool_in.output.address
  expect utils.asset_qty(pool_out.value, r.pool_nft) == 1
  let r_ada_out = assets.lovelace_of(pool_out.value)
  let r_tok_out = utils.asset_qty(pool_out.value, r.token)

  // (6) O(N) positional binding: owner-outputs are the first N outputs in
  // canonical (input) order. Length guard: every order has a real bound output.
  let n = list.length(order_inputs)
  let owner_outputs = list.take(tx.outputs, n)
  expect list.length(owner_outputs) == n
  let tx_upper = finite_upper(tx.validity_range)
  let (net_tok, net_ada) = process_orders(
    order_inputs,
    owner_outputs,
    r,
    tx_upper,
  )

  // no minting/burning in a settlement (LP mint only at create/close)
  expect assets.is_zero(tx.mint)

  // (1) the pool absorbs EXACTLY the net residual — token-sellers and ADA-sellers
  // net against each other; only the imbalance moves the pool. Pinning the pool
  // exactly (plus per-order pinning above) forces the solver to take only tips
  // (ledger conservation), so no separate global-conservation pass is needed.
  expect r_tok_out == r_tok_in + net_tok
  expect r_ada_out == r_ada_in + net_ada

  // NB: k_after >= k_before is enforced by the POOL validator (§5.4 split).
  True
}
