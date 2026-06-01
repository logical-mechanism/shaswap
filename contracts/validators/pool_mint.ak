//// Pool creation/closure minting policy. One-shot per pool: parameterised by a
//// seed OutputReference, so the policy hash (hence the pool NFT) is unique and
//// `Create` can fire only once. Thin wrapper over `shaswap/mint`.

use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use shaswap/mint
use shaswap/types.{Close, Create, MintRedeemer}

validator pool_mint(seed: OutputReference) {
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      Create -> mint.create(seed, policy_id, self)
      Close -> mint.close(policy_id, self)
    }
  }

  else(_) {
    fail
  }
}
