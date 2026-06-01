//! The typed, fail-fast solver configuration. Loaded once at startup from JSON;
//! [`Config::validate`] rejects anything malformed AND — critically — any protocol
//! constant that drifts from `constants.ak` (a drift would silently produce
//! settlements the validators reject). Deserialized identities are hex strings,
//! parsed and checked here.

use serde::Deserialize;
use solver_core::types::{
    AssetId, Credential, OutputReference, LP_NAME, MIN_LIQ, NFT_NAME, ORDER_MIN_ADA, POOL_MIN_ADA,
    TOTAL_LP,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    BadHex {
        field: &'static str,
    },
    BadLength {
        field: &'static str,
        want: usize,
        got: usize,
    },
    /// A protocol constant doesn't match `constants.ak`.
    ConstantDrift {
        field: &'static str,
        want: i128,
        got: i128,
    },
    /// A byte-string constant (asset name) doesn't match `constants.ak`.
    NameDrift {
        field: &'static str,
    },
}

/// A UTXO reference in `"txid#index"` form.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RefInput {
    pub tx_id: String,
    pub index: u64,
}

/// The deployment-specific config, as deserialized (hex strings). Call
/// [`Config::validate`] before use.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Config {
    pub network_id: u8,
    pub network_magic: u64,
    pub kupo_url: String,
    pub ogmios_url: String,

    /// Settlement stake credential `S` (script hash, hex).
    pub settlement_hash: String,
    pub order_script_hash: String,
    pub pool_script_hash: String,
    pub pool_mint_policy: String,

    /// Pool NFT name (hex) and LP name (hex) — must equal `constants.ak`.
    pub nft_name: String,
    pub lp_name: String,

    /// Protocol constants — MUST equal `constants.ak`.
    pub total_lp: i128,
    pub min_liq: i128,
    pub pool_min_ada: i128,
    pub order_min_ada: i128,

    /// On-chain reference scripts (deployed at bootstrap).
    pub settlement_ref: RefInput,
    pub order_ref: RefInput,
    pub pool_ref: RefInput,

    /// Path to the solver wallet signing key.
    pub signing_key_path: String,

    /// Max orders settled per settlement tx. A pool with more settleable orders is
    /// drained across multiple **chained** txs (k batches of ≤ this many), so the
    /// whole orderbook clears in one pass. Conservative by default; raising it packs
    /// more orders per tx (fewer txs, less fee overhead) — but a value whose batch
    /// exceeds the per-tx ex-unit/size budget makes that tx fail and the pool be
    /// skipped until enough orders drop. Optional in the deployment JSON (default 20).
    #[serde(default = "default_max_orders_per_tx")]
    pub max_orders_per_tx: usize,
}

/// Conservative default for [`Config::max_orders_per_tx`] — well inside the v1
/// ~40-order per-tx ceiling, leaving head-room for ex-unit/size variance.
fn default_max_orders_per_tx() -> usize {
    20
}

fn hex_bytes(s: &str, field: &'static str) -> Result<Vec<u8>, ConfigError> {
    if s.len() % 2 != 0 {
        return Err(ConfigError::BadHex { field });
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ConfigError::BadHex { field }))
        .collect()
}

fn hash28(s: &str, field: &'static str) -> Result<Vec<u8>, ConfigError> {
    let b = hex_bytes(s, field)?;
    if b.len() != 28 {
        return Err(ConfigError::BadLength {
            field,
            want: 28,
            got: b.len(),
        });
    }
    Ok(b)
}

impl Config {
    /// Validate hex/lengths and assert every protocol constant matches `constants.ak`.
    /// Returns the parsed identities so the caller doesn't re-parse.
    pub fn validate(&self) -> Result<ValidatedConfig, ConfigError> {
        let check = |field, want: i128, got: i128| {
            if want == got {
                Ok(())
            } else {
                Err(ConfigError::ConstantDrift { field, want, got })
            }
        };
        check("total_lp", TOTAL_LP, self.total_lp)?;
        check("min_liq", MIN_LIQ, self.min_liq)?;
        check("pool_min_ada", POOL_MIN_ADA, self.pool_min_ada)?;
        check("order_min_ada", ORDER_MIN_ADA, self.order_min_ada)?;

        let nft_name = hex_bytes(&self.nft_name, "nft_name")?;
        if nft_name != NFT_NAME {
            return Err(ConfigError::NameDrift { field: "nft_name" });
        }
        let lp_name = hex_bytes(&self.lp_name, "lp_name")?;
        if lp_name != LP_NAME {
            return Err(ConfigError::NameDrift { field: "lp_name" });
        }

        let settlement_cred = Credential::Script(hash28(&self.settlement_hash, "settlement_hash")?);
        let pool_mint_policy = hash28(&self.pool_mint_policy, "pool_mint_policy")?;
        let pool_nft = AssetId::new(pool_mint_policy.clone(), nft_name);

        Ok(ValidatedConfig {
            network_id: self.network_id,
            settlement_cred,
            order_script_hash: hash28(&self.order_script_hash, "order_script_hash")?,
            pool_script_hash: hash28(&self.pool_script_hash, "pool_script_hash")?,
            pool_mint_policy,
            pool_nft,
            kupo_url: self.kupo_url.clone(),
            ogmios_url: self.ogmios_url.clone(),
            settlement_ref: ref_input(&self.settlement_ref, "settlement_ref")?,
            order_ref: ref_input(&self.order_ref, "order_ref")?,
            pool_ref: ref_input(&self.pool_ref, "pool_ref")?,
            // Clamp to ≥ 1 — a 0 cap would never include any order.
            max_orders_per_tx: self.max_orders_per_tx.max(1),
        })
    }

    /// Parse + validate from a JSON string.
    pub fn from_json(s: &str) -> Result<ValidatedConfig, ConfigErrorOrParse> {
        let cfg: Config =
            serde_json::from_str(s).map_err(|e| ConfigErrorOrParse::Parse(e.to_string()))?;
        cfg.validate().map_err(ConfigErrorOrParse::Config)
    }
}

fn ref_input(r: &RefInput, field: &'static str) -> Result<OutputReference, ConfigError> {
    let tx = hex_bytes(&r.tx_id, field)?;
    if tx.len() != 32 {
        return Err(ConfigError::BadLength {
            field,
            want: 32,
            got: tx.len(),
        });
    }
    Ok(OutputReference {
        transaction_id: tx,
        output_index: r.index,
    })
}

#[derive(Debug, Clone)]
pub enum ConfigErrorOrParse {
    Parse(String),
    Config(ConfigError),
}

/// The validated, parsed config the rest of the solver uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedConfig {
    pub network_id: u8,
    pub settlement_cred: Credential,
    pub order_script_hash: Vec<u8>,
    pub pool_script_hash: Vec<u8>,
    pub pool_mint_policy: Vec<u8>,
    pub pool_nft: AssetId,
    pub kupo_url: String,
    pub ogmios_url: String,
    pub settlement_ref: OutputReference,
    pub order_ref: OutputReference,
    pub pool_ref: OutputReference,
    /// Max orders per settlement tx (≥ 1; see [`Config::max_orders_per_tx`]).
    pub max_orders_per_tx: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_json() -> String {
        format!(
            r#"{{
              "network_id": 0, "network_magic": 1,
              "kupo_url": "http://localhost:1442", "ogmios_url": "http://localhost:1337",
              "settlement_hash": "{s}", "order_script_hash": "{s}",
              "pool_script_hash": "{s}", "pool_mint_policy": "{s}",
              "nft_name": "4e4654", "lp_name": "4c50",
              "total_lp": 9223372036854775807, "min_liq": 1000,
              "pool_min_ada": 2000000, "order_min_ada": 2000000,
              "settlement_ref": {{"tx_id": "{t}", "index": 0}},
              "order_ref": {{"tx_id": "{t}", "index": 1}},
              "pool_ref": {{"tx_id": "{t}", "index": 2}},
              "signing_key_path": "/keys/solver.skey"
            }}"#,
            s = "55".repeat(28),
            t = "d1".repeat(32),
        )
    }

    #[test]
    fn valid_config_parses_and_binds_pool_nft() {
        let v = Config::from_json(&good_json()).expect("valid");
        assert_eq!(v.pool_nft.name, NFT_NAME);
        assert_eq!(v.settlement_cred, Credential::Script(vec![0x55; 28]));
        assert_eq!(v.order_ref.output_index, 1);
    }

    #[test]
    fn max_orders_per_tx_defaults_and_overrides() {
        // Absent in the JSON → the conservative default (20).
        let v = Config::from_json(&good_json()).expect("valid");
        assert_eq!(v.max_orders_per_tx, 20);

        // Present → taken verbatim.
        let with = good_json().replace(
            "\"order_min_ada\": 2000000,",
            "\"order_min_ada\": 2000000, \"max_orders_per_tx\": 35,",
        );
        assert_eq!(Config::from_json(&with).unwrap().max_orders_per_tx, 35);

        // 0 is clamped to ≥ 1 (a 0 cap would never include any order).
        let zero = good_json().replace(
            "\"order_min_ada\": 2000000,",
            "\"order_min_ada\": 2000000, \"max_orders_per_tx\": 0,",
        );
        assert_eq!(Config::from_json(&zero).unwrap().max_orders_per_tx, 1);
    }

    #[test]
    fn constant_drift_is_rejected() {
        let bad = good_json().replace("\"min_liq\": 1000", "\"min_liq\": 999");
        match Config::from_json(&bad) {
            Err(ConfigErrorOrParse::Config(ConfigError::ConstantDrift {
                field: "min_liq",
                want: 1000,
                got: 999,
            })) => {}
            other => panic!("expected min_liq drift, got {other:?}"),
        }
    }

    #[test]
    fn wrong_nft_name_is_rejected() {
        let bad = good_json().replace("\"nft_name\": \"4e4654\"", "\"nft_name\": \"abcd\"");
        assert!(matches!(
            Config::from_json(&bad),
            Err(ConfigErrorOrParse::Config(ConfigError::NameDrift {
                field: "nft_name"
            }))
        ));
    }

    #[test]
    fn bad_hash_length_is_rejected() {
        let bad = good_json().replace(&"55".repeat(28), "5555");
        assert!(matches!(
            Config::from_json(&bad),
            Err(ConfigErrorOrParse::Config(ConfigError::BadLength { .. }))
        ));
    }
}
