//// The once-per-tx settlement validator (BLUEPRINT §5.4): a withdraw-0 staking
//// script that runs the full §5.2 batch checks a single time per transaction.
//// Two handlers expose the two order->output binding strategies so the spike
//// can measure both. In production only one would ship.

use cardano/address.{Credential}
use cardano/transaction.{Transaction}
use shaswap/types.{SettlementRedeemer}
use shaswap/validation

/// Naive O(N^2) binding: each order scans every output for its bound output.
validator settlement_naive {
  withdraw(
    redeemer: SettlementRedeemer,
    _account: Credential,
    self: Transaction,
  ) {
    validation.validate_naive(redeemer, self)
  }

  else(_) {
    fail
  }
}

/// Indexed O(N) binding: owner-outputs occupy the first N output positions in
/// canonical input order; positional bijection gives injectivity.
validator settlement_indexed {
  withdraw(
    redeemer: SettlementRedeemer,
    _account: Credential,
    self: Transaction,
  ) {
    validation.validate_indexed(redeemer, self)
  }

  else(_) {
    fail
  }
}
