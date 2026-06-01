//// The once-per-tx settlement validator — the immutable trust anchor (§5.4).
//// A withdraw-0 staking script, **unparameterised** (stable hash, nothing to be
//// circular with). It learns its own credential `S` at run time as the withdraw
//// purpose's account and enumerates/accounts for every input tagged with `S`.

use cardano/address.{Credential}
use cardano/transaction.{Transaction}
use shaswap/clearing
use shaswap/types.{SettlementRedeemer}

validator settlement {
  withdraw(redeemer: SettlementRedeemer, account: Credential, self: Transaction) {
    clearing.run(account, redeemer, self)
  }

  else(_) {
    fail
  }
}
