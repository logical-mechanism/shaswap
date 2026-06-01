//// Tests for pool create/close mint logic (`shaswap/mint`).

use cardano/address.{Address, Inline, Script}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use shaswap/constants.{lp_name, nft_name, total_lp}
use shaswap/mint
use shaswap/types.{AssetId, PoolDatum}

const policy = #"4444444444444444444444444444444444444444444444444444444e"

const seed_txid =
  #"7777777777777777777777777777777777777777777777777777777777777777"

const p_hash = #"9999999999999999999999999999999999999999999999999999999c"

fn seed() -> OutputReference {
  OutputReference { transaction_id: seed_txid, output_index: 3 }
}

fn seed_input() -> Input {
  Input {
    output_reference: seed(),
    output: Output {
      address: Address {
        payment_credential: Script(p_hash),
        stake_credential: None,
      },
      value: assets.from_lovelace(5_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

fn pool_datum() -> PoolDatum {
  PoolDatum {
    nft: AssetId { policy, name: nft_name },
    asset_a: AssetId {
      policy: #"3333333333333333333333333333333333333333333333333333333d",
      name: #"54",
    },
    asset_b: AssetId { policy: #"", name: #"" },
    fee_num: 3,
    fee_den: 1000,
  }
}

// the seed pool output holding NFT + full LP supply
fn pool_seed_output(v: Value) -> Output {
  Output {
    address: Address {
      payment_credential: Script(p_hash),
      stake_credential: Some(Inline(Script(p_hash))),
    },
    value: v,
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

fn mint_val(nft_qty: Int, lp_qty: Int) -> Value {
  assets.from_asset(policy, nft_name, nft_qty)
    |> assets.add(policy, lp_name, lp_qty)
}

// ---- create ---------------------------------------------------------------

test create_ok() {
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
    |> assets.add(policy, lp_name, total_lp)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_input()],
    outputs: [pool_seed_output(pool_v)],
    mint: mint_val(1, total_lp),
  }
  mint.create(seed(), policy, tx)
}

// seed not consumed: not a one-shot create => rejected.
test create_no_seed() fail {
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
    |> assets.add(policy, lp_name, total_lp)
  let tx = Transaction {
    ..transaction.placeholder,
    outputs: [pool_seed_output(pool_v)],
    mint: mint_val(1, total_lp),
  }
  mint.create(seed(), policy, tx)
}

// wrong LP amount minted: rejected.
test create_wrong_amount() fail {
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
    |> assets.add(policy, lp_name, total_lp - 1)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_input()],
    outputs: [pool_seed_output(pool_v)],
    mint: mint_val(1, total_lp - 1),
  }
  mint.create(seed(), policy, tx)
}

// a stray third asset minted under the policy: rejected.
test create_extra_asset() fail {
  let bad_mint = mint_val(1, total_lp) |> assets.add(policy, #"6a6e6b", 5)
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
    |> assets.add(policy, lp_name, total_lp)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_input()],
    outputs: [pool_seed_output(pool_v)],
    mint: bad_mint,
  }
  mint.create(seed(), policy, tx)
}

// NFT and LP do not land together in one output: rejected.
test create_split_output() fail {
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_input()],
    outputs: [pool_seed_output(pool_v)],
    mint: mint_val(1, total_lp),
  }
  mint.create(seed(), policy, tx)
}

// ---- close ----------------------------------------------------------------

test close_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    mint: mint_val(-1, -total_lp),
  }
  mint.close(policy, tx)
}

// any positive (re)mint during close: rejected.
test close_positive() fail {
  let tx = Transaction { ..transaction.placeholder, mint: mint_val(-1, 7) }
  mint.close(policy, tx)
}
