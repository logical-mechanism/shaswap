//! Lower a `solver-core` [`Address`]/[`Credential`] into raw Cardano address bytes,
//! and build the reward account for the settlement stake credential `S` (the
//! withdraw-0 account). Uses `pallas-addresses`.
//!
//! - Owner payout → enterprise Shelley address (payment cred, no delegation).
//! - Tagged order/pool/remainder → base Shelley address (payment cred + `Inline(S)`
//!   as the delegation part).
//! - Reward account for `S` → a script stake address (`S` is the settlement
//!   validator's own script hash).

use pallas_addresses::{
    Network, ShelleyAddress, ShelleyDelegationPart, ShelleyPaymentPart, StakeAddress, StakePayload,
};
use pallas_crypto::hash::Hash;
use solver_core::output::Address;
use solver_core::types::Credential;

/// Error lowering an address (e.g. a credential hash of the wrong length).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddressError {
    BadHashLength(usize),
}

fn hash28(bytes: &[u8]) -> Result<Hash<28>, AddressError> {
    let arr: [u8; 28] = bytes
        .try_into()
        .map_err(|_| AddressError::BadHashLength(bytes.len()))?;
    Ok(Hash::from(arr))
}

pub fn network(id: u8) -> Network {
    Network::from(id)
}

fn payment_part(c: &Credential) -> Result<ShelleyPaymentPart, AddressError> {
    Ok(match c {
        Credential::VerificationKey(h) => ShelleyPaymentPart::Key(hash28(h)?),
        Credential::Script(h) => ShelleyPaymentPart::Script(hash28(h)?),
    })
}

fn delegation_part(stake: &Option<Credential>) -> Result<ShelleyDelegationPart, AddressError> {
    Ok(match stake {
        None => ShelleyDelegationPart::Null,
        Some(Credential::VerificationKey(h)) => ShelleyDelegationPart::Key(hash28(h)?),
        Some(Credential::Script(h)) => ShelleyDelegationPart::Script(hash28(h)?),
    })
}

/// Raw bytes of the Shelley address for a settlement output.
pub fn shelley_bytes(net: Network, addr: &Address) -> Result<Vec<u8>, AddressError> {
    let a = ShelleyAddress::new(
        net,
        payment_part(&addr.payment)?,
        delegation_part(&addr.stake)?,
    );
    Ok(a.to_vec())
}

/// Raw bytes of the reward account for the settlement stake credential `S`
/// (always a script credential). This is the key of the withdraw-0 entry.
pub fn reward_account(net: Network, s: &Credential) -> Result<Vec<u8>, AddressError> {
    let payload = match s {
        Credential::Script(h) => StakePayload::Script(hash28(h)?),
        Credential::VerificationKey(h) => StakePayload::Stake(hash28(h)?),
    };
    Ok(StakeAddress::new(net, payload).to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vk(b: u8) -> Credential {
        Credential::VerificationKey(vec![b; 28])
    }
    fn sc(b: u8) -> Credential {
        Credential::Script(vec![b; 28])
    }

    #[test]
    fn enterprise_vs_base_address_differ_and_roundtrip() {
        let net = network(0);
        let payout = Address {
            payment: vk(0xb1),
            stake: None,
        };
        let tagged = Address {
            payment: sc(0x0b),
            stake: Some(sc(0x55)),
        };
        let pb = shelley_bytes(net, &payout).unwrap();
        let tb = shelley_bytes(net, &tagged).unwrap();
        assert_ne!(pb, tb);
        // enterprise address (payment-only) is 1 header + 28 = 29 bytes;
        // base address (payment + stake) is 1 + 28 + 28 = 57 bytes.
        assert_eq!(pb.len(), 29);
        assert_eq!(tb.len(), 57);
    }

    #[test]
    fn reward_account_is_29_bytes() {
        // stake address = 1 header byte + 28-byte credential.
        let ra = reward_account(network(0), &sc(0x55)).unwrap();
        assert_eq!(ra.len(), 29);
    }

    #[test]
    fn bad_hash_length_errors() {
        let bad = Address {
            payment: Credential::Script(vec![0x00; 10]),
            stake: None,
        };
        assert_eq!(
            shelley_bytes(network(0), &bad),
            Err(AddressError::BadHashLength(10))
        );
    }
}
