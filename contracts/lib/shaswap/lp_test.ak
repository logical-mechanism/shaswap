//// Tests for the value-derived LP path (`spend.lp_action`, BLUEPRINT §6 Rev 7):
//// withdraw exit, proportional deposit, first-deposit sqrt + min-liq lock, and
//// rejection of over-mint / over-withdraw / missing-lock / bad-sqrt / NFT-drop /
//// stray-mint.

use aiken/fuzz
use aiken/math
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use shaswap/constants.{lp_name, min_liq, nft_name, pool_min_ada, total_lp}
use shaswap/spend
use shaswap/types.{AssetId, PoolDatum}

const s_hash = #"5555555555555555555555555555555555555555555555555555555a"

const p_hash = #"9999999999999999999999999999999999999999999999999999999c"

const pool_txid =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

const nft_policy = #"4444444444444444444444444444444444444444444444444444444e"

const nft = AssetId { policy: nft_policy, name: #"4e4654" }

const ada = AssetId { policy: #"", name: #"" }

const creator_vkh = #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

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

fn pool_addr() -> Address {
  Address {
    payment_credential: Script(p_hash),
    stake_credential: Some(Inline(Script(s_hash))),
  }
}

fn pool_val(ada_res: Int, tok_amt: Int, held: Int) -> Value {
  assets.from_lovelace(ada_res + pool_min_ada)
    |> assets.add(tok.policy, tok.name, tok_amt)
    |> assets.add(nft.policy, nft.name, 1)
    |> assets.add(nft.policy, lp_name, held)
}

fn pool_ref() -> OutputReference {
  OutputReference { transaction_id: pool_txid, output_index: 0 }
}

fn pool_in(ada_res: Int, tok_amt: Int, held: Int) -> Input {
  Input {
    output_reference: pool_ref(),
    output: Output {
      address: pool_addr(),
      value: pool_val(ada_res, tok_amt, held),
      datum: InlineDatum(pool_datum()),
      reference_script: None,
    },
  }
}

fn pool_out(ada_res: Int, tok_amt: Int, held: Int, with_nft: Bool) -> Output {
  let base = assets.from_lovelace(ada_res + pool_min_ada)
    |> assets.add(tok.policy, tok.name, tok_amt)
    |> assets.add(nft.policy, lp_name, held)
  let v = if with_nft {
    base |> assets.add(nft.policy, nft.name, 1)
  } else {
    base
  }
  Output {
    address: pool_addr(),
    value: v,
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

fn burn_out(lp_qty: Int) -> Output {
  Output {
    address: Address {
      payment_credential: Script(nft_policy),
      stake_credential: None,
    },
    value: assets.from_lovelace(pool_min_ada)
      |> assets.add(nft.policy, lp_name, lp_qty),
    datum: NoDatum,
    reference_script: None,
  }
}

fn lp_tx(pin: Input, pout: Output) -> Transaction {
  Transaction { ..transaction.placeholder, inputs: [pin], outputs: [pout] }
}

// ---- withdraw (the inviolable exit) ---------------------------------------

// hold 1_000_000 circulating against reserves 100M ADA / 200M token; withdraw
// 10% proportionally.
test withdraw_ok() {
  spend.lp_action(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(90_000_000, 180_000_000, total_lp - 900_000, True),
    ),
    pool_ref(),
    pool_datum(),
  )
}

// take more reserves than the returned shares entitle: rejected.
test withdraw_too_much() fail {
  spend.lp_action(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(89_000_000, 180_000_000, total_lp - 900_000, True),
    ),
    pool_ref(),
    pool_datum(),
  )
}

// drain reserves while returning ZERO shares: rejected (can't take without burning).
test withdraw_no_shares() fail {
  spend.lp_action(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(90_000_000, 180_000_000, total_lp - 1_000_000, True),
    ),
    pool_ref(),
    pool_datum(),
  )
}

// ---- deposit --------------------------------------------------------------

test deposit_ok() {
  spend.lp_action(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(110_000_000, 220_000_000, total_lp - 1_100_000, True),
    ),
    pool_ref(),
    pool_datum(),
  )
}

// mint more shares than the added reserves back: rejected (dilutes existing LPs).
test deposit_overmint() fail {
  spend.lp_action(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(110_000_000, 220_000_000, total_lp - 1_200_000, True),
    ),
    pool_ref(),
    pool_datum(),
  )
}

// ---- token/token pool (neither reserve is ADA) ----------------------------
// asset_a = tok, asset_b = tokb; lovelace is pure pool_min_ada overhead, never a
// reserve. A proportional deposit must satisfy per-share backing in both tokens.

const tokb =
  AssetId {
    policy: #"888888888888888888888888888888888888888888888888888888ff",
    name: #"42",
  }

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

fn tt_pool(res_a: Int, res_b: Int, held: Int) -> Output {
  Output {
    address: pool_addr(),
    value: assets.from_lovelace(pool_min_ada)
      |> assets.add(tok.policy, tok.name, res_a)
      |> assets.add(tokb.policy, tokb.name, res_b)
      |> assets.add(nft.policy, nft.name, 1)
      |> assets.add(nft.policy, lp_name, held),
    datum: InlineDatum(tt_datum()),
    reference_script: None,
  }
}

// 10% proportional deposit into a token/token pool: ok.
test deposit_token_token() {
  let pin = Input {
    output_reference: pool_ref(),
    output: tt_pool(100_000_000, 200_000_000, total_lp - 1_000_000),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pin],
    outputs: [tt_pool(110_000_000, 220_000_000, total_lp - 1_100_000)],
  }
  spend.lp_action(tx, pool_ref(), tt_datum())
}

// over-withdraw from a token/token pool (take more than shares entitle): rejected.
test withdraw_token_token_too_much() fail {
  let pin = Input {
    output_reference: pool_ref(),
    output: tt_pool(100_000_000, 200_000_000, total_lp - 1_000_000),
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pin],
    // return 10% of shares but take ~11% of reserve_a
    outputs: [tt_pool(89_000_000, 180_000_000, total_lp - 900_000)],
  }
  spend.lp_action(tx, pool_ref(), tt_datum())
}

// ---- first deposit (circ_in == 0) -----------------------------------------

// sqrt(100M · 100M) = 100M shares; lock 1000.
test first_deposit_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    outputs: [
      pool_out(100_000_000, 100_000_000, total_lp - 100_000_000, True),
      burn_out(min_liq),
    ],
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// no min-liq locked: rejected.
test first_deposit_no_lock() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    outputs: [pool_out(100_000_000, 100_000_000, total_lp - 100_000_000, True)],
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// shares minted != floor(sqrt(reserveA·reserveB)): rejected.
test first_deposit_bad_sqrt() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    outputs: [
      pool_out(100_000_000, 100_000_000, total_lp - 99_999_999, True),
      burn_out(min_liq),
    ],
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// ---- structural negatives -------------------------------------------------

// pool output drops the NFT: no continuity, rejected.
test nft_drop() fail {
  spend.lp_action(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(90_000_000, 180_000_000, total_lp - 900_000, False),
    ),
    pool_ref(),
    pool_datum(),
  )
}

// any mint/burn during an LP action: rejected.
test stray_mint() fail {
  let tx = Transaction {
    ..lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(90_000_000, 180_000_000, total_lp - 900_000, True),
    ),
    mint: assets.from_asset(nft.policy, lp_name, 5),
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// ---- close (unseeded pool teardown) ---------------------------------------

fn close_mint(nft_qty: Int, lp_qty: Int) -> Value {
  assets.from_asset(nft_policy, nft_name, nft_qty)
    |> assets.add(nft_policy, lp_name, lp_qty)
}

// unseeded pool (holds all LP): creator signs, burn NFT + full LP supply.
test close_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    mint: close_mint(-1, -total_lp),
    extra_signatories: [creator_vkh],
  }
  spend.pool_close(tx, pool_ref(), pool_datum())
}

// creator did NOT sign: a stranger cannot tear down / grief the pool (§13.10).
test close_no_creator_sig() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    mint: close_mint(-1, -total_lp),
  }
  spend.pool_close(tx, pool_ref(), pool_datum())
}

// pool has outstanding LP (held < total_lp): cannot be closed (would rob LPs).
test close_live_pool() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(100_000_000, 200_000_000, total_lp - 1_000_000)],
    mint: close_mint(-1, -total_lp),
    extra_signatories: [creator_vkh],
  }
  spend.pool_close(tx, pool_ref(), pool_datum())
}

// NFT not burned: pool not truly torn down, rejected.
test close_no_nft_burn() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    mint: close_mint(0, -total_lp),
    extra_signatories: [creator_vkh],
  }
  spend.pool_close(tx, pool_ref(), pool_datum())
}

// ---- property / fuzz tests (aiken/fuzz) -----------------------------------
// Pair convention here: asset_a = tok, asset_b = ada, so pool_in/pool_out's
// (ada_res, tok_amt) map to (res_b, res_a). All LP arithmetic is value-derived.

// PROPERTY: a first deposit's minted shares == floor(sqrt(res_a · res_b)) across
// random reserves — the on-chain `is_sqrt` agrees with `math.sqrt` everywhere.
// (reserves ≥ 2000 ⇒ product ≥ 4e6 ⇒ sqrt ≥ 2000 > min_liq, so the lock holds.)
test prop_first_deposit_sqrt(
  p via fuzz.both(
    fuzz.int_between(2000, 1_000_000_000),
    fuzz.int_between(2000, 1_000_000_000),
  ),
) {
  let (ada_res, tok_amt) = p
  expect Some(c) = math.sqrt(ada_res * tok_amt)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    outputs: [pool_out(ada_res, tok_amt, total_lp - c, True), burn_out(min_liq)],
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

fn deposit_params() -> Fuzzer<(Int, Int, Int)> {
  fuzz.map3(
    fuzz.int_between(1, 1_000_000),
    fuzz.int_between(1, 1_000_000),
    fuzz.int_between(2, 50),
    fn(a, b, c) { (a, b, c) },
  )
}

// PROPERTY: an exactly-proportional deposit (scale reserves AND circulating by m)
// is always accepted — per-share backing is preserved across random reserves/scale.
test prop_deposit_proportional(p via deposit_params()) {
  let (ada_res, tok_amt, m) = p
  let circ_in = 1_000_000
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(ada_res, tok_amt, total_lp - circ_in)],
    outputs: [pool_out(ada_res * m, tok_amt * m, total_lp - circ_in * m, True)],
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// PROPERTY (tightness): minting one share beyond proportional is ALWAYS rejected
// (dilutes existing LPs) — for every reserve/scale.
test prop_deposit_overmint(p via deposit_params()) fail {
  let (ada_res, tok_amt, m) = p
  let circ_in = 1_000_000
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(ada_res, tok_amt, total_lp - circ_in)],
    outputs: [
      pool_out(ada_res * m, tok_amt * m, total_lp - ( circ_in * m + 1 ), True),
    ],
  }
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// ---- benchmarks: LP deposit/withdraw + worst-case first-deposit sqrt (I-01) --

fn deposit_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(110_000_000, 220_000_000, total_lp - 1_100_000, True),
    ),
  )
}

bench pool__lp_action__deposit(tx via deposit_tx) {
  spend.lp_action(tx, pool_ref(), pool_datum())
}

fn first_deposit_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    Transaction {
      ..transaction.placeholder,
      inputs: [pool_in(0, 0, total_lp)],
      outputs: [
        pool_out(100_000_000, 100_000_000, total_lp - 100_000_000, True),
        burn_out(min_liq),
      ],
    },
  )
}

// worst-case path: the first-deposit `is_sqrt` check.
bench pool__lp_action__first_deposit(tx via first_deposit_tx) {
  spend.lp_action(tx, pool_ref(), pool_datum())
}

// cold paths: LP withdraw branch + pre-seed teardown (audit I-04).
fn withdraw_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    lp_tx(
      pool_in(100_000_000, 200_000_000, total_lp - 1_000_000),
      pool_out(90_000_000, 180_000_000, total_lp - 900_000, True),
    ),
  )
}

bench pool__lp_action__withdraw(tx via withdraw_tx) {
  spend.lp_action(tx, pool_ref(), pool_datum())
}

fn pool_close_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    Transaction {
      ..transaction.placeholder,
      inputs: [pool_in(0, 0, total_lp)],
      mint: close_mint(-1, -total_lp),
      extra_signatories: [creator_vkh],
    },
  )
}

bench pool__pool_close(tx via pool_close_tx) {
  spend.pool_close(tx, pool_ref(), pool_datum())
}
