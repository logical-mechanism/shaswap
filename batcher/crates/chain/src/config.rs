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

impl std::fmt::Display for ConfigError {
    /// Operator-facing message: what is wrong AND where to fix it. A config error is
    /// almost always a hand-edit slip or a stale/cross-network deployment.json, so each
    /// variant points at the concrete remediation rather than just naming the field.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::BadHex { field } => write!(
                f,
                "config field `{field}` is not valid hex (odd length or a non-hex digit) — \
                 check for a transposed or missing character in your deployment.json"
            ),
            ConfigError::BadLength { field, want, got } => write!(
                f,
                "config field `{field}` decoded to {got} bytes, expected {want} — a script \
                 hash is 28 bytes (56 hex chars) and a tx id is 32 bytes (64 hex chars); \
                 re-copy it from the deployment output"
            ),
            ConfigError::ConstantDrift { field, want, got } => write!(
                f,
                "protocol constant `{field}` is {got} but the deployed contracts use {want} — \
                 these are baked into contracts/lib/shaswap/constants.ak; regenerate \
                 deployment.json from the deployed contracts (a drift makes EVERY settlement \
                 rejected on-chain). A likely cause is a preprod config run against mainnet \
                 (or vice versa)"
            ),
            ConfigError::NameDrift { field } => write!(
                f,
                "constant byte-string `{field}` does not match constants.ak — use the exact \
                 nft_name/lp_name hex from the deployed contracts"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

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
    /// The unparameterised `lp_intent` validator hash (BLUEPRINT §5.1 Rev 22). Its
    /// UTXOs sit at an enterprise address (payment = this hash, stake = `None`).
    pub lp_intent_script_hash: String,

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
    /// Reference script UTXO for the `lp_intent` validator. **Optional** — it is
    /// deployed only at the Phase-4 redeploy (the lp_intent validator joins the
    /// reference-script set then), so a pre-Phase-4 deployment JSON omits it and LP
    /// intent fulfillment is simply disabled (settlements are unaffected). Once
    /// present, the batcher references it (alongside `pool_ref`) to fulfil intents.
    #[serde(default)]
    pub lp_intent_ref: Option<RefInput>,

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

    /// Cross-pool/shard drain ordering for a pass (the order pools are attempted in
    /// when chaining). The orchestrator parses this into its `Strategy` enum — an
    /// unknown value falls back to the default. Currently `"round-robin"` (fair,
    /// starvation-free) or `"profit-greedy"` (highest Σtips first); more can be
    /// added later. Overridable with `SHASWAP_STRATEGY`. Optional (default round-robin).
    #[serde(default = "default_strategy")]
    pub strategy: String,
}

/// Conservative default for [`Config::max_orders_per_tx`] — well inside the v1
/// ~40-order per-tx ceiling, leaving head-room for ex-unit/size variance.
fn default_max_orders_per_tx() -> usize {
    20
}

/// Default drain strategy — fair round-robin (no pool starved, no herd on the
/// richest pool). See the orchestrator's `Strategy`.
fn default_strategy() -> String {
    "round-robin".to_string()
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
            lp_intent_script_hash: hash28(&self.lp_intent_script_hash, "lp_intent_script_hash")?,
            pool_mint_policy,
            pool_nft,
            kupo_url: self.kupo_url.clone(),
            ogmios_url: self.ogmios_url.clone(),
            settlement_ref: ref_input(&self.settlement_ref, "settlement_ref")?,
            order_ref: ref_input(&self.order_ref, "order_ref")?,
            pool_ref: ref_input(&self.pool_ref, "pool_ref")?,
            lp_intent_ref: self
                .lp_intent_ref
                .as_ref()
                .map(|r| ref_input(r, "lp_intent_ref"))
                .transpose()?,
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

impl std::fmt::Display for ConfigErrorOrParse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigErrorOrParse::Parse(e) => write!(f, "config JSON parse error: {e}"),
            ConfigErrorOrParse::Config(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ConfigErrorOrParse {}

/// The validated, parsed config the rest of the solver uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedConfig {
    pub network_id: u8,
    pub settlement_cred: Credential,
    pub order_script_hash: Vec<u8>,
    pub pool_script_hash: Vec<u8>,
    pub lp_intent_script_hash: Vec<u8>,
    pub pool_mint_policy: Vec<u8>,
    pub pool_nft: AssetId,
    pub kupo_url: String,
    pub ogmios_url: String,
    pub settlement_ref: OutputReference,
    pub order_ref: OutputReference,
    pub pool_ref: OutputReference,
    /// Reference-script UTXO for the `lp_intent` validator, if deployed (Phase 4).
    /// `None` disables LP-intent fulfillment (the batcher can't reference the
    /// validator); settlements are unaffected. See [`Config::lp_intent_ref`].
    pub lp_intent_ref: Option<OutputReference>,
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
              "lp_intent_script_hash": "{s}",
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
    fn lp_intent_ref_is_optional_and_parses_when_present() {
        // Absent in the JSON → None (pre-Phase-4 deployment; LP fulfillment off).
        let v = Config::from_json(&good_json()).expect("valid");
        assert_eq!(v.lp_intent_ref, None);

        // Present → parsed into an OutputReference.
        let tx = "d1".repeat(32);
        let with = good_json().replace(
            "\"signing_key_path\"",
            &format!(
                "\"lp_intent_ref\": {{\"tx_id\": \"{tx}\", \"index\": 3}}, \"signing_key_path\""
            ),
        );
        let v = Config::from_json(&with).expect("valid with lp_intent_ref");
        let r = v.lp_intent_ref.expect("lp_intent_ref present");
        assert_eq!(r.output_index, 3);
        assert_eq!(r.transaction_id, vec![0xd1u8; 32]);
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
    fn config_errors_carry_remediation_hints() {
        // The Display message must name the field AND point at where to fix it, so an
        // operator isn't left with a bare `ConstantDrift { .. }` debug dump.
        let drift = ConfigError::ConstantDrift {
            field: "min_liq",
            want: 1000,
            got: 999,
        };
        let msg = drift.to_string();
        assert!(
            msg.contains("min_liq") && msg.contains("constants.ak"),
            "{msg}"
        );

        let bad_hex = ConfigError::BadHex { field: "pool_ref" }.to_string();
        assert!(bad_hex.contains("pool_ref") && bad_hex.contains("deployment.json"));

        // ConfigErrorOrParse forwards to the inner Display (with its hint).
        let wrapped = ConfigErrorOrParse::Config(ConfigError::NameDrift { field: "nft_name" });
        assert!(wrapped.to_string().contains("constants.ak"));
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
