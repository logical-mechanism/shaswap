//// The order validator — the user-facing trust anchor (§5.4). Parameterised by
//// the settlement staking credential `S`. Thin wrapper over `shaswap/spend`:
//// `Settle` defers to the once-per-tx settlement validator (and self-enforces the
//// `S` tag, closing the input-smuggle path §8); `Reclaim` is owner-signature-only
//// (§5.1). It never re-runs §5.2.

use cardano/address.{Credential}
use cardano/transaction.{OutputReference, Transaction}
use shaswap/spend
use shaswap/types.{OrderDatum, OrderRedeemer, Reclaim, Settle}

validator order(settlement_cred: Credential) {
  spend(
    datum: Option<OrderDatum>,
    redeemer: OrderRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Settle -> spend.order_settle(self, utxo, settlement_cred)
      Reclaim -> spend.order_reclaim(d.owner, self)
    }
  }

  else(_) {
    fail
  }
}
