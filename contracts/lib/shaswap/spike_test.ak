//// Ex-unit spike harness (BLUEPRINT §13.1). Synthesises a settlement
//// ScriptContext with N orders + N owner-outputs + one constant-product pool,
//// runs both binding variants, and lets `aiken check` report mem/cpu per test.
////
//// Each N has THREE tests:
////   build_*   — builds the tx and forces it, but runs NO validation. This is
////               the construction-cost baseline to subtract.
////   naive_*   — build + validate with O(N^2) scan binding.
////   indexed_* — build + validate with O(N) positional binding.
//// True validator cost at N = (naive|indexed)_N − build_N.

use aiken/collection/list
use cardano/address.{
  Address, Script, VerificationKey, from_script, from_verification_key,
}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use shaswap/config
use shaswap/types.{BoundDatum, OrderDatum, PoolDatum, SettlementRedeemer}
use shaswap/validation

// ---- spike scenario constants --------------------------------------------

const order_txid: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const pool_txid: ByteArray =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

const owner_vkh: ByteArray =
  #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

const solver_vkh: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

const sell: Int = 1_000_000

const tip: Int = 2_000_000

const min_ada: Int = 2_000_000

const order_in_ada: Int = min_ada + tip

// price = 1/2 ADA per X  =>  received = sell/2 = 500_000
const price_num: Int = 1

const price_den: Int = 2

const received: Int = sell * price_num / price_den

const limit: Int = 400_000

const owner_out_ada: Int = order_in_ada - tip + received

// large pool reserves so k stays comfortably non-decreasing across the sweep
const pool_ada_in: Int = 1_000_000_000_000

const pool_x_in: Int = 1_000_000_000_000

const redeemer: SettlementRedeemer = SettlementRedeemer { price_num, price_den }

// ---- builders -------------------------------------------------------------

fn x_value(lovelace: Int, x: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(config.token_policy, config.token_name, x)
}

fn order_ref(i: Int) -> OutputReference {
  OutputReference { transaction_id: order_txid, output_index: i }
}

fn mk_order_input(i: Int) -> Input {
  Input {
    output_reference: order_ref(i),
    output: Output {
      address: from_script(config.order_hash),
      value: x_value(order_in_ada, sell),
      datum: InlineDatum(
        OrderDatum {
          owner: VerificationKey(owner_vkh),
          sell_amount: sell,
          limit,
          tip,
          partial: False,
        },
      ),
      reference_script: None,
    },
  }
}

fn mk_owner_output(i: Int) -> Output {
  Output {
    address: from_verification_key(owner_vkh),
    value: assets.from_lovelace(owner_out_ada),
    datum: InlineDatum(BoundDatum { order_ref: order_ref(i) }),
    reference_script: None,
  }
}

fn pool_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: pool_txid,
      output_index: 0,
    },
    output: Output {
      address: from_script(config.pool_hash),
      value: x_value(pool_ada_in, pool_x_in),
      datum: InlineDatum(PoolDatum { fee_num: 3, fee_den: 1000 }),
      reference_script: None,
    },
  }
}

fn pool_output(n: Int) -> Output {
  Output {
    address: from_script(config.pool_hash),
    value: x_value(pool_ada_in - received * n, pool_x_in + sell * n),
    datum: InlineDatum(PoolDatum { fee_num: 3, fee_den: 1000 }),
    reference_script: None,
  }
}

fn solver_output(n: Int) -> Output {
  Output {
    address: from_verification_key(solver_vkh),
    value: assets.from_lovelace(tip * n),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

/// Build a full settlement tx for N orders. Owner-outputs come first (positions
/// 0..N), then the pool output, then the solver tip output — the canonical
/// layout the indexed binding requires.
fn build(n: Int) -> Transaction {
  let ids = list.range(0, n - 1)
  let order_inputs = list.map(ids, mk_order_input)
  let owner_outputs = list.map(ids, mk_owner_output)
  Transaction {
    ..transaction.placeholder,
    inputs: list.concat(order_inputs, [pool_input()]),
    outputs: list.concat(owner_outputs, [pool_output(n), solver_output(n)]),
    withdrawals: [Pair(Script(config.settlement_hash), 0)],
  }
}

// ---- baseline: build only (construction cost to subtract) -----------------

fn forced(tx: Transaction) -> Bool {
  list.length(tx.inputs) + list.length(tx.outputs) > 0
}

test build_n1() {
  forced(build(1))
}

test build_n2() {
  forced(build(2))
}

test build_n5() {
  forced(build(5))
}

test build_n10() {
  forced(build(10))
}

test build_n20() {
  forced(build(20))
}

test build_n30() {
  forced(build(30))
}

test build_n50() {
  forced(build(50))
}

test build_n100() {
  forced(build(100))
}

// ---- naive O(N^2) binding -------------------------------------------------

test naive_n1() {
  validation.validate_naive(redeemer, build(1))
}

test naive_n2() {
  validation.validate_naive(redeemer, build(2))
}

test naive_n5() {
  validation.validate_naive(redeemer, build(5))
}

test naive_n10() {
  validation.validate_naive(redeemer, build(10))
}

test naive_n20() {
  validation.validate_naive(redeemer, build(20))
}

test naive_n30() {
  validation.validate_naive(redeemer, build(30))
}

test naive_n50() {
  validation.validate_naive(redeemer, build(50))
}

test naive_n100() {
  validation.validate_naive(redeemer, build(100))
}

// ---- indexed O(N) binding -------------------------------------------------

test indexed_n1() {
  validation.validate_indexed(redeemer, build(1))
}

test indexed_n2() {
  validation.validate_indexed(redeemer, build(2))
}

test indexed_n5() {
  validation.validate_indexed(redeemer, build(5))
}

test indexed_n10() {
  validation.validate_indexed(redeemer, build(10))
}

test indexed_n20() {
  validation.validate_indexed(redeemer, build(20))
}

test indexed_n30() {
  validation.validate_indexed(redeemer, build(30))
}

test indexed_n50() {
  validation.validate_indexed(redeemer, build(50))
}

test indexed_n100() {
  validation.validate_indexed(redeemer, build(100))
}

// ---- order spend deferral: O(1), runs ONCE PER ORDER INPUT ----------------
// On-chain each spent order input separately invokes the order validator,
// whose only work is this O(1) withdrawal check; those costs SUM toward the tx
// budget alongside the single settlement validator. Cost is independent of N
// (a 1-entry withdrawals list), so one measurement (minus build_n1) gives the
// per-order deferral cost. (The on-chain order spend additionally pays per-input
// ScriptContext Data-decoding overhead not modelled by typed-value tests.)

test order_defer() {
  validation.settlement_present(build(1))
}
