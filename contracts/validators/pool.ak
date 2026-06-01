//// The constant-product pool validator. Parameterised by the settlement staking
//// credential `S`. Thin wrapper over `shaswap/spend`. Under the §5.4
//// responsibility split it **owns its own curve invariant** (`k_after >= k_before`
//// from actual reserves) and defers the batch-wide §5.2 checks to the settlement
//// anchor. New curves (stableswap, PA-AMM, …) are separate pool validators reusing
//// the unchanged anchor.

use cardano/address.{Credential}
use cardano/transaction.{OutputReference, Transaction}
use shaswap/spend
use shaswap/types.{LpAction, PoolDatum, PoolRedeemer, PoolSettle}

validator pool(settlement_cred: Credential) {
  spend(
    datum: Option<PoolDatum>,
    redeemer: PoolRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      PoolSettle -> spend.pool_settle(self, utxo, d, settlement_cred)
      // TODO(milestone): LP deposit/withdraw (share-token based, §5.1 spend path
      // (b)). MUST guarantee LPs can always exit before production. Stubbed.
      LpAction -> fail
    }
  }

  else(_) {
    fail
  }
}
