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
use shaswap/utils

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
      // Standalone LP deposit/withdraw (§5.1 spend path (b), §6 LP model). Must
      // NOT coincide with a settlement (mutual exclusion), then runs the
      // value-derived LP invariant.
      LpAction -> and {
          !utils.withdrawal_present(self, settlement_cred),
          spend.lp_action(self, utxo, d),
        }
    }
  }

  else(_) {
    fail
  }
}
