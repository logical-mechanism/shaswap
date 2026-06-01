//// Shared on-chain helpers.

use aiken/collection/list
use cardano/address.{Address, Credential, Inline}
use cardano/assets.{Value}
use cardano/transaction.{Output, Transaction}
use shaswap/types.{AssetId}

/// Is this output tagged with the settlement staking credential `s` (Rev 6 §5.4
/// stake-credential tag)?
pub fn is_tagged(output: Output, s: Credential) -> Bool {
  output.address.stake_credential == Some(Inline(s))
}

/// A continuing protocol output (a recreated pool or a re-locked remainder): its
/// address is pinned EXACTLY (payment + stake credential) and it carries NO
/// reference script. Pinning the full address keeps a remainder tagged `S` and a
/// pool at its own credential; rejecting an attached reference script blocks a
/// solver bloating the output's min-ADA (audit L-01). Value/datum are pinned by
/// the caller.
pub fn is_protocol_output(o: Output, addr: Address) -> Bool {
  o.address == addr && o.reference_script == None
}

/// An owner payout output: the payment credential is the owner's, the stake
/// credential is fixed to `None` (a fresh, undelegated payout — so a solver can't
/// hijack its staking rewards by setting a stake credential it controls, audit
/// M-01), and no reference script rides along (audit L-01). Value/datum are pinned
/// by the caller.
pub fn is_payout_output(o: Output, owner: Credential) -> Bool {
  o.address == Address { payment_credential: owner, stake_credential: None } && o.reference_script == None
}

/// Is the settlement withdraw-0 present for credential `s`? (O(1) deferral.)
pub fn withdrawal_present(tx: Transaction, s: Credential) -> Bool {
  list.any(tx.withdrawals, fn(p) { p.1st == s })
}

/// Quantity of a given asset in a value.
pub fn asset_qty(v: Value, a: AssetId) -> Int {
  assets.quantity_of(v, a.policy, a.name)
}
