//// Shared on-chain helpers.

use aiken/collection/list
use cardano/address.{Credential, Inline}
use cardano/assets.{Value}
use cardano/transaction.{Output, Transaction}
use shaswap/types.{AssetId}

/// Is this output tagged with the settlement staking credential `s` (Rev 6 §5.4
/// stake-credential tag)?
pub fn is_tagged(output: Output, s: Credential) -> Bool {
  output.address.stake_credential == Some(Inline(s))
}

/// Is the settlement withdraw-0 present for credential `s`? (O(1) deferral.)
pub fn withdrawal_present(tx: Transaction, s: Credential) -> Bool {
  list.any(tx.withdrawals, fn(p) { p.1st == s })
}

/// Quantity of a given asset in a value.
pub fn asset_qty(v: Value, a: AssetId) -> Int {
  assets.quantity_of(v, a.policy, a.name)
}
