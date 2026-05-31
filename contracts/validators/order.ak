//// The order validator — the immutable trust anchor (§5.4). Its spend path is
//// deliberately cheap: it does NOT re-run the §5.2 checks per order. It only
//// defers to the once-per-tx settlement validator via an O(1) "is the
//// settlement withdrawal present?" check, or lets the owner reclaim on their
//// signature alone. The expensive verification happens once in `settlement`.

use aiken/collection/list
use cardano/address.{VerificationKey}
use cardano/transaction.{OutputReference, Transaction}
use shaswap/types.{OrderDatum, OrderRedeemer, Reclaim, Settle}
use shaswap/validation

validator order {
  spend(
    datum: Option<OrderDatum>,
    redeemer: OrderRedeemer,
    _utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      // Defer the heavy lifting to the once-per-tx settlement validator.
      Settle -> validation.settlement_present(self)
      // Non-custodial reclaim: owner signature alone (§5.1).
      Reclaim -> {
        expect VerificationKey(vkh) = d.owner
        list.has(self.extra_signatories, vkh)
      }
    }
  }

  else(_) {
    fail
  }
}
