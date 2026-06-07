//! A minimal ledger model — just enough of `cardano/transaction.Output` and
//! `cardano/address.Address` for the clearing mirror to *pin* outputs and for the
//! (future) `txbuild` crate to lower them into a real Pallas transaction.
//!
//! Only the `Inline` stake-credential form is modelled (the protocol tags UTXOs
//! with `Some(Inline(S))`; payouts pin the order datum's `owner_stake` — `Some(c)`
//! for a base address, `None` for an enterprise one).

use crate::types::{BoundDatum, Credential, LpIntentDatum, OrderDatum, OutputReference, PoolDatum};
use crate::value::Value;

/// A shelley address: payment credential + optional (inline) stake credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub payment: Credential,
    /// `None` == undelegated. The protocol's stake *tag* `S` is represented here
    /// as `Some(Credential::Script(s))`.
    pub stake: Option<Credential>,
}

impl Address {
    /// An owner payout address: payment = owner, stake = the order datum's
    /// `owner_stake` (`Some(c)` → base address, `None` → enterprise), per
    /// `utils.is_payout_output`. The stake is read from the datum, never chosen by
    /// the solver (M-01: solver can't redirect the payout / hijack staking rewards).
    pub fn payout(owner: Credential, owner_stake: Option<Credential>) -> Self {
        Address {
            payment: owner,
            stake: owner_stake,
        }
    }

    /// Is this output tagged with the settlement stake credential `s`
    /// (`utils.is_tagged`)?
    pub fn is_tagged(&self, s: &Credential) -> bool {
        self.stake.as_ref() == Some(s)
    }
}

/// The datum attached to an output. Typed (rather than raw `Data`) so the pin
/// generator emits exactly the right shape; CBOR encoding is a `txbuild` concern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Datum {
    None,
    Order(OrderDatum),
    Pool(PoolDatum),
    Bound(BoundDatum),
}

/// A transaction output. `reference_script` is pinned to `None` on every protocol
/// output (audit L-01: a solver can't bloat min-ADA with an attached ref script).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub address: Address,
    pub value: Value,
    pub datum: Datum,
    pub reference_script: Option<Vec<u8>>,
}

/// An order UTXO being consumed by the settlement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderInput {
    pub output_reference: OutputReference,
    pub address: Address,
    pub value: Value,
    pub datum: OrderDatum,
}

/// The pool UTXO being consumed by the settlement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolInput {
    pub output_reference: OutputReference,
    pub address: Address,
    pub value: Value,
    pub datum: PoolDatum,
}

/// An LP-intent UTXO being consumed by a fulfillment tx (BLUEPRINT §5.1 Rev 22).
/// Sits at the `lp_intent` validator's address with a `None` (enterprise) stake
/// credential — never the settlement tag `S`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpIntentInput {
    pub output_reference: OutputReference,
    pub address: Address,
    pub value: Value,
    pub datum: LpIntentDatum,
}
