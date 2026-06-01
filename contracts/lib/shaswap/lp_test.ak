//// Tests for the value-derived LP path (`spend.lp_action`, BLUEPRINT §6 Rev 7):
//// withdraw exit, proportional deposit, first-deposit sqrt + min-liq lock, and
//// rejection of over-mint / over-withdraw / missing-lock / bad-sqrt / NFT-drop /
//// stray-mint.

use cardano/address.{Address, Inline, Script}
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

fn pool_datum() -> PoolDatum {
  PoolDatum { nft, token: tok, fee_num: 3, fee_den: 1000 }
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

// unseeded pool (holds all LP): burn NFT + full LP supply.
test close_ok() {
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
  }
  spend.pool_close(tx, pool_ref(), pool_datum())
}

// NFT not burned: pool not truly torn down, rejected.
test close_no_nft_burn() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [pool_in(0, 0, total_lp)],
    mint: close_mint(0, -total_lp),
  }
  spend.pool_close(tx, pool_ref(), pool_datum())
}
