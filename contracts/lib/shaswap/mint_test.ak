//// Tests for pool create/close mint logic (`shaswap/mint`).

use aiken/fuzz
use cardano/address.{Address, Inline, Script, VerificationKey}
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

const creator_vkh = #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

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
    creator: VerificationKey(creator_vkh),
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

// (I-03) creator is a Script credential, not a VK: rejected at create. ClosePool
// authorizes the pre-seed teardown by signature, so a Script creator would
// silently brick that path — fail fast at the only validating gate instead.
test create_script_creator() fail {
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
    |> assets.add(policy, lp_name, total_lp)
  let bad_output = Output {
    address: Address {
      payment_credential: Script(p_hash),
      stake_credential: Some(Inline(Script(p_hash))),
    },
    value: pool_v,
    datum: InlineDatum(PoolDatum { ..pool_datum(), creator: Script(p_hash) }),
    reference_script: None,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_input()],
    outputs: [bad_output],
    mint: mint_val(1, total_lp),
  }
  mint.create(seed(), policy, tx)
}

// (L-03) the pool output holds less than the carved-out min-ADA overhead, so its
// ADA reserve (`lovelace − pool_min_ada`) would be negative and the pool could never
// be settled or deposited into: rejected at create.
test create_below_min_ada() fail {
  let pool_v = assets.from_lovelace(1_500_000)
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

// (audit I-05) a holder may burn their OWN circulating LP via a standalone Close
// (no pool input, no signer): a deliberate self-forfeiture. circ = total_lp - held
// is value-derived from the pool UTXO, so this can't touch the pool's accounting or
// other LPs — the burned shares' reserves just stay permanently locked (like
// min_liq). Pinned here as an intended property, not a bug. (Combining a burn with
// an LpAction is separately rejected by `lp_action`'s `mint == 0`, cf. stray_mint.)
test close_burns_circulating_lp() {
  let tx = Transaction {
    ..transaction.placeholder,
    mint: assets.from_asset(policy, lp_name, -5),
  }
  mint.close(policy, tx)
}

// ---- benchmark: pool creation (I-01) --------------------------------------

fn create_tx(_n: Int) -> Fuzzer<Transaction> {
  let pool_v = assets.from_lovelace(2_000_000)
    |> assets.add(policy, nft_name, 1)
    |> assets.add(policy, lp_name, total_lp)
  fuzz.constant(
    Transaction {
      ..transaction.placeholder,
      inputs: [seed_input()],
      outputs: [pool_seed_output(pool_v)],
      mint: mint_val(1, total_lp),
    },
  )
}

bench pool_mint__create(tx via create_tx) {
  mint.create(seed(), policy, tx)
}

// cold path: burn-only close (audit I-04).
fn close_tx(_n: Int) -> Fuzzer<Transaction> {
  fuzz.constant(
    Transaction { ..transaction.placeholder, mint: mint_val(-1, -total_lp) },
  )
}

bench pool_mint__close(tx via close_tx) {
  mint.close(policy, tx)
}
