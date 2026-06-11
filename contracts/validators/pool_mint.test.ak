//// Validator-entrypoint tests for the pool_mint one-shot policy (audit I-01, Fable5).
//// These drive the real `pool_mint.mint` wrapper — the `Create`/`Close` redeemer
//// dispatch — under a constructed `Transaction`. The create/close logic is covered at
//// the lib layer in `mint_test.ak`; this closes the wrapper-dispatch gap. `Create`
//// consumes the seed + mints exactly {NFT, LP} into a validated pool output; `Close`
//// is burn-only.

use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use pool_mint
use shaswap/constants.{lp_name, nft_name, pool_min_ada, total_lp}
use shaswap/types.{AssetId, Close, Create, PoolDatum}

const nft_policy = #"4444444444444444444444444444444444444444444444444444444e"

const pool_hash = #"9999999999999999999999999999999999999999999999999999999c"

const creator_vkh = #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

const tok =
  AssetId {
    policy: #"3333333333333333333333333333333333333333333333333333333d",
    name: #"54",
  }

fn pool_datum() -> PoolDatum {
  PoolDatum {
    nft: AssetId { policy: nft_policy, name: nft_name },
    asset_a: tok,
    asset_b: AssetId { policy: #"", name: #"" },
    fee_num: 3,
    fee_den: 1000,
    creator: VerificationKey(creator_vkh),
  }
}

fn seed_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
    output_index: 0,
  }
}

// the seed UTXO the one-shot policy consumes (its contents are irrelevant; only its
// presence at `seed_ref()` matters).
fn seed_in() -> Input {
  Input {
    output_reference: seed_ref(),
    output: Output {
      address: Address {
        payment_credential: VerificationKey(creator_vkh),
        stake_credential: None,
      },
      value: assets.from_lovelace(10_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    },
  }
}

// the created pool output: NFT + full LP supply + ≥ pool_min_ada, with a well-formed
// PoolDatum. `mint.create` locates it by (NFT==1, LP==total_lp) and validates the datum;
// it does NOT constrain the address (that is the off-chain placement invariant, L-02).
fn pool_out() -> Output {
  Output {
    address: Address {
      payment_credential: Script(pool_hash),
      stake_credential: None,
    },
    value: assets.from_lovelace(pool_min_ada)
      |> assets.add(nft_policy, nft_name, 1)
      |> assets.add(nft_policy, lp_name, total_lp),
    datum: InlineDatum(pool_datum()),
    reference_script: None,
  }
}

// (audit I-01) Create arm via the wrapper: seed consumed + exactly {NFT:1, LP:total_lp}
// minted into one validated pool output ⇒ passes.
test pool_mint_create_via_wrapper_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_in()],
    mint: assets.from_asset(nft_policy, nft_name, 1)
      |> assets.add(nft_policy, lp_name, total_lp),
    outputs: [pool_out()],
  }
  pool_mint.pool_mint.mint(seed_ref(), Create, nft_policy, tx)
}

// Create without the seed input: the one-shot gate rejects (proves the Create arm reaches
// `mint.create`, which requires the seed — distinct from `Close`).
test pool_mint_create_via_wrapper_no_seed() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    mint: assets.from_asset(nft_policy, nft_name, 1)
      |> assets.add(nft_policy, lp_name, total_lp),
    outputs: [pool_out()],
  }
  pool_mint.pool_mint.mint(seed_ref(), Create, nft_policy, tx)
}

// (audit I-01) Close arm via the wrapper: burn-only (every triple for the policy ≤ 0).
test pool_mint_close_via_wrapper_ok() {
  let tx = Transaction {
    ..transaction.placeholder,
    mint: assets.from_asset(nft_policy, nft_name, -1)
      |> assets.add(nft_policy, lp_name, -total_lp),
  }
  pool_mint.pool_mint.mint(seed_ref(), Close, nft_policy, tx)
}

// Close that MINTS a positive quantity under the policy: rejected (proves the Close arm
// reaches `mint.close`'s burn-only `q ≤ 0` gate).
test pool_mint_close_via_wrapper_positive() fail {
  let tx = Transaction {
    ..transaction.placeholder,
    mint: assets.from_asset(nft_policy, nft_name, 1),
  }
  pool_mint.pool_mint.mint(seed_ref(), Close, nft_policy, tx)
}
