//// Fixed identities for the spike. In production the settlement validator would
//// be parameterised by these; constants keep the measurement code lean.

use cardano/assets.{AssetName, PolicyId}

/// Payment-credential script hash of the order validator (the trust anchor).
pub const order_hash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

/// Payment-credential script hash of the constant-product pool validator.
pub const pool_hash: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"

/// Stake-credential script hash of the withdraw-0 settlement validator. Orders
/// defer to it via the cheap "is this withdrawal present?" O(1) check (§5.4).
pub const settlement_hash: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

/// Policy id of the traded token X (the non-ADA side of the pool).
pub const token_policy: PolicyId =
  #"33333333333333333333333333333333333333333333333333333333"

/// Asset name of token X (the byte 0x58 = "X").
pub const token_name: AssetName = #"58"
