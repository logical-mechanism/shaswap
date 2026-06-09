//! The typed, fail-fast solver configuration. Loaded once at startup from JSON;
//! [`Config::validate`] parses and length-checks the deployment identities (script
//! hashes and reference-script UTXOs). It carries ONLY what the batcher actually
//! consumes: pool discovery is dynamic — every pool self-describes via its `PoolDatum`,
//! so there is no per-pool or per-token config (no pool mint policy, no asset names).

use serde::Deserialize;
use solver_core::types::{Credential, OutputReference};

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
    /// The unparameterised `lp_intent` validator hash (BLUEPRINT §5.1 Rev 22). Its
    /// UTXOs sit at an enterprise address (payment = this hash, stake = `None`).
    pub lp_intent_script_hash: String,

    /// On-chain reference scripts (deployed at bootstrap).
    pub settlement_ref: RefInput,
    pub order_ref: RefInput,
    pub pool_ref: RefInput,
    /// Reference script UTXO for the `lp_intent` validator. **Optional** — the
    /// lp_intent validator is live on preprod and mainnet, but a deployment JSON may
    /// omit it to run settlements-only, in which case LP intent fulfillment is simply
    /// disabled (settlements are unaffected). Once present, the batcher references it
    /// (alongside `pool_ref`) to fulfil intents.
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
    /// Validate hex/lengths of the deployment identities and parse them into the
    /// runtime form. Returns the parsed identities so the caller doesn't re-parse.
    pub fn validate(&self) -> Result<ValidatedConfig, ConfigError> {
        Ok(ValidatedConfig {
            network_id: self.network_id,
            settlement_cred: Credential::Script(hash28(&self.settlement_hash, "settlement_hash")?),
            order_script_hash: hash28(&self.order_script_hash, "order_script_hash")?,
            pool_script_hash: hash28(&self.pool_script_hash, "pool_script_hash")?,
            lp_intent_script_hash: hash28(&self.lp_intent_script_hash, "lp_intent_script_hash")?,
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
    pub kupo_url: String,
    pub ogmios_url: String,
    pub settlement_ref: OutputReference,
    pub order_ref: OutputReference,
    pub pool_ref: OutputReference,
    /// Reference-script UTXO for the `lp_intent` validator, if configured.
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
              "pool_script_hash": "{s}", "lp_intent_script_hash": "{s}",
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
    fn valid_config_parses() {
        let v = Config::from_json(&good_json()).expect("valid");
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
            "\"signing_key_path\"",
            "\"max_orders_per_tx\": 35, \"signing_key_path\"",
        );
        assert_eq!(Config::from_json(&with).unwrap().max_orders_per_tx, 35);

        // 0 is clamped to ≥ 1 (a 0 cap would never include any order).
        let zero = good_json().replace(
            "\"signing_key_path\"",
            "\"max_orders_per_tx\": 0, \"signing_key_path\"",
        );
        assert_eq!(Config::from_json(&zero).unwrap().max_orders_per_tx, 1);
    }

    #[test]
    fn lp_intent_ref_is_optional_and_parses_when_present() {
        // Absent in the JSON → None (settlements-only config; LP fulfillment off).
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
    fn config_errors_carry_remediation_hints() {
        // The Display message must name the field AND point at where to fix it, so an
        // operator isn't left with a bare `BadHex { .. }` debug dump.
        let bad_hex = ConfigError::BadHex { field: "pool_ref" }.to_string();
        assert!(bad_hex.contains("pool_ref") && bad_hex.contains("deployment.json"));

        let bad_len = ConfigError::BadLength {
            field: "settlement_hash",
            want: 28,
            got: 4,
        }
        .to_string();
        assert!(bad_len.contains("settlement_hash") && bad_len.contains("28 bytes"));

        // ConfigErrorOrParse forwards to the inner Display (with its hint).
        let wrapped = ConfigErrorOrParse::Config(ConfigError::BadHex { field: "order_ref" });
        assert!(wrapped.to_string().contains("order_ref"));
    }

    #[test]
    fn bad_hash_length_is_rejected() {
        let bad = good_json().replace(&"55".repeat(28), "5555");
        assert!(matches!(
            Config::from_json(&bad),
            Err(ConfigErrorOrParse::Config(ConfigError::BadLength { .. }))
        ));
    }

    #[test]
    fn example_deployment_files_parse() {
        // The committed example configs must always satisfy the current schema, so an
        // operator copying one gets a parseable config — and the examples can't silently
        // drift from `Config` (e.g. a field that has since been removed).
        for src in [
            include_str!("../../../config/deployment.preprod.example.json"),
            include_str!("../../../config/deployment.mainnet.example.json"),
        ] {
            Config::from_json(src).expect("example deployment config must validate");
        }
    }
}
