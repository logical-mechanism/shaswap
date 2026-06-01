//// Protocol constants (BLUEPRINT §6 LP model, Rev 7).

use cardano/assets.{AssetName}

/// Total LP-token supply, minted in full into the pool UTXO at creation.
/// Circulating supply = `total_lp − (LP held in the pool UTXO)`; no counter is
/// stored. Matches the common Cardano "mint-all-upfront, hold-in-pool" pattern.
pub const total_lp: Int = 9_223_372_036_854_775_807

/// Permanently-locked minimum liquidity (Uniswap-v2 style). On the first deposit,
/// `min_liq` LP is sent to the unspendable mint-policy address so circulating
/// supply can never return to ~0 (bounds the first-depositor donation attack).
pub const min_liq: Int = 1_000

/// Per-UTXO min-ADA carved out of the pool's ADA reserve so it is never counted
/// as tradeable/withdrawable liquidity (§5.2.1 ADA roles): the pool must always
/// retain at least this much lovelace.
pub const pool_min_ada: Int = 2_000_000

/// LP-token asset name (under the pool's mint policy = `nft.policy`). "LP".
pub const lp_name: AssetName = #"4c50"

/// Pool-NFT asset name (under the same mint policy). "NFT".
pub const nft_name: AssetName = #"4e4654"
