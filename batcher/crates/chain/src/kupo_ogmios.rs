//! The live [`ChainBackend`] implementation backed by **Kupo** (UTXO discovery,
//! REST on `:1442`) and **Ogmios** (tip, protocol parameters, the `EvaluateTx`
//! pre-submit gate, and submission — JSON-RPC on `:1337`).
//!
//! This is the one provider-specific module behind the [`ChainBackend`] seam
//! (CLAUDE.md's swappable data-access rule). The JSON↔domain parsing is factored
//! into free functions that take `serde_json::Value`, so they're unit-tested
//! against fixtures captured from the live services — independently of the HTTP
//! transport, which is exercised live by the orchestrator.

use crate::backend::{ChainBackend, ExUnits, ProtocolParams, Purpose, RedeemerEval, Tip, Utxo};
use crate::config::ValidatedConfig;
use crate::decode::{self, DecodeError};
use pallas_addresses::Network;
use serde_json::{json, Value as Json};
use solver_core::output::{Address, OrderInput, PoolInput};
use solver_core::types::{AssetId, Credential, OutputReference};
use solver_core::value::Value;
use txbuild::address as txaddr;

/// Everything that can go wrong talking to the chain.
#[derive(Debug, Clone)]
pub enum ChainError {
    /// HTTP/transport failure.
    Http(String),
    /// A JSON-RPC / REST response we couldn't make sense of.
    Shape(String),
    /// Ogmios (or the node) returned a structured error (e.g. EvaluateTx failed,
    /// submission rejected).
    Service(String),
    /// A discovered datum failed to decode into a domain type.
    Decode(DecodeError),
    /// Couldn't derive an address from the config.
    Address(String),
    /// The pool UTXO (carrying the NFT) wasn't found.
    PoolNotFound,
}

impl From<DecodeError> for ChainError {
    fn from(e: DecodeError) -> Self {
        ChainError::Decode(e)
    }
}

// ---------------------------------------------------------------------------
// Pure parsing — unit-tested against live fixtures, no IO.
// ---------------------------------------------------------------------------

fn hex_to_bytes(s: &str) -> Result<Vec<u8>, ChainError> {
    hex::decode(s).map_err(|e| ChainError::Shape(format!("bad hex `{s}`: {e}")))
}

/// Parse a `"num/den"` rational (Ogmios encodes prices this way).
fn parse_ratio(s: &str) -> Result<(u64, u64), ChainError> {
    let (n, d) = s
        .split_once('/')
        .ok_or_else(|| ChainError::Shape(format!("not a ratio: {s}")))?;
    Ok((
        n.trim()
            .parse()
            .map_err(|_| ChainError::Shape(format!("ratio num: {s}")))?,
        d.trim()
            .parse()
            .map_err(|_| ChainError::Shape(format!("ratio den: {s}")))?,
    ))
}

fn field<'a>(v: &'a Json, key: &str) -> Result<&'a Json, ChainError> {
    v.get(key)
        .ok_or_else(|| ChainError::Shape(format!("missing field `{key}`")))
}

fn as_u64(v: &Json, ctx: &str) -> Result<u64, ChainError> {
    v.as_u64()
        .ok_or_else(|| ChainError::Shape(format!("expected u64 at {ctx}")))
}

fn as_str<'a>(v: &'a Json, ctx: &str) -> Result<&'a str, ChainError> {
    v.as_str()
        .ok_or_else(|| ChainError::Shape(format!("expected string at {ctx}")))
}

/// The `result` of a JSON-RPC reply, or a `Service` error built from `error`.
fn rpc_result(reply: &Json) -> Result<&Json, ChainError> {
    if let Some(err) = reply.get("error") {
        return Err(ChainError::Service(err.to_string()));
    }
    field(reply, "result")
}

/// Parse `queryNetwork/tip` → [`Tip`].
pub fn parse_tip(reply: &Json) -> Result<Tip, ChainError> {
    let r = rpc_result(reply)?;
    Ok(Tip {
        slot: as_u64(field(r, "slot")?, "tip.slot")?,
    })
}

/// Parse `queryLedgerState/protocolParameters` → [`ProtocolParams`].
pub fn parse_protocol_params(reply: &Json) -> Result<ProtocolParams, ChainError> {
    let r = rpc_result(reply)?;

    let min_fee_a = as_u64(field(r, "minFeeCoefficient")?, "minFeeCoefficient")?;
    let min_fee_b = as_u64(
        field(field(field(r, "minFeeConstant")?, "ada")?, "lovelace")?,
        "minFeeConstant",
    )?;

    let prices = field(r, "scriptExecutionPrices")?;
    let price_mem = parse_ratio(as_str(field(prices, "memory")?, "prices.memory")?)?;
    let price_step = parse_ratio(as_str(field(prices, "cpu")?, "prices.cpu")?)?;

    let max = field(r, "maxExecutionUnitsPerTransaction")?;
    let max_tx_ex_units = ExUnits {
        mem: as_u64(field(max, "memory")?, "maxEx.memory")?,
        steps: as_u64(field(max, "cpu")?, "maxEx.cpu")?,
    };

    let coins_per_utxo_byte = as_u64(field(r, "minUtxoDepositCoefficient")?, "minUtxoCoeff")?;

    let cost_model_v3 = field(field(r, "plutusCostModels")?, "plutus:v3")?
        .as_array()
        .ok_or_else(|| ChainError::Shape("plutus:v3 not an array".into()))?
        .iter()
        .map(|x| {
            x.as_i64()
                .ok_or_else(|| ChainError::Shape("cost model entry not i64".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let refs = field(r, "minFeeReferenceScripts")?;
    let ref_script_base = field(refs, "base")?
        .as_f64()
        .ok_or_else(|| ChainError::Shape("refScripts.base".into()))?;
    let ref_script_range = as_u64(field(refs, "range")?, "refScripts.range")?;
    let ref_script_multiplier = field(refs, "multiplier")?
        .as_f64()
        .ok_or_else(|| ChainError::Shape("refScripts.multiplier".into()))?;

    Ok(ProtocolParams {
        min_fee_a,
        min_fee_b,
        price_mem,
        price_step,
        max_tx_ex_units,
        coins_per_utxo_byte,
        cost_model_v3,
        ref_script_base,
        ref_script_range,
        ref_script_multiplier,
    })
}

fn purpose_from_str(s: &str) -> Result<Purpose, ChainError> {
    Ok(match s {
        "spend" => Purpose::Spend,
        "mint" => Purpose::Mint,
        "withdraw" => Purpose::Withdraw,
        "publish" => Purpose::Cert,
        "vote" => Purpose::Vote,
        "propose" => Purpose::Propose,
        other => return Err(ChainError::Shape(format!("unknown purpose `{other}`"))),
    })
}

/// Parse `evaluateTransaction` → per-redeemer ex-units. Ogmios v6 returns
/// `[{ "validator": {"index","purpose"}, "budget": {"memory","cpu"} }]`.
pub fn parse_evaluate(reply: &Json) -> Result<Vec<RedeemerEval>, ChainError> {
    let r = rpc_result(reply)?;
    let arr = r
        .as_array()
        .ok_or_else(|| ChainError::Shape("evaluate result not an array".into()))?;
    arr.iter()
        .map(|e| {
            let v = field(e, "validator")?;
            let (purpose, index) = match v {
                // object form (v6.x): {"index": N, "purpose": "spend"}
                Json::Object(_) => (
                    purpose_from_str(as_str(field(v, "purpose")?, "validator.purpose")?)?,
                    as_u64(field(v, "index")?, "validator.index")? as u32,
                ),
                // string form ("spend:0") — older/alt encoding.
                Json::String(s) => {
                    let (p, i) = s
                        .split_once(':')
                        .ok_or_else(|| ChainError::Shape(format!("bad validator `{s}`")))?;
                    (
                        purpose_from_str(p)?,
                        i.parse()
                            .map_err(|_| ChainError::Shape(format!("bad index `{i}`")))?,
                    )
                }
                _ => return Err(ChainError::Shape("validator shape".into())),
            };
            let b = field(e, "budget")?;
            Ok(RedeemerEval {
                purpose,
                index,
                ex_units: ExUnits {
                    mem: as_u64(field(b, "memory")?, "budget.memory")?,
                    steps: as_u64(field(b, "cpu")?, "budget.cpu")?,
                },
            })
        })
        .collect()
}

/// Parse `submitTransaction` → the 32-byte tx id.
pub fn parse_submit(reply: &Json) -> Result<Vec<u8>, ChainError> {
    let r = rpc_result(reply)?;
    let id = as_str(field(field(r, "transaction")?, "id")?, "submit.id")?;
    hex_to_bytes(id)
}

/// A Kupo match, parsed into the bits the solver needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KupoMatch {
    pub output_reference: OutputReference,
    pub address: String,
    pub value: Value,
    pub datum_hash: Option<String>,
    pub script_hash: Option<String>,
}

/// Convert a Kupo `value` object (`{coins, assets}`) to a solver-core [`Value`].
pub fn parse_kupo_value(v: &Json) -> Result<Value, ChainError> {
    let coins = as_u64(field(v, "coins")?, "value.coins")? as i128;
    let mut out = Value::from_lovelace(coins);
    if let Some(assets) = v.get("assets").and_then(|a| a.as_object()) {
        for (key, qty) in assets {
            let amount = qty
                .as_u64()
                .ok_or_else(|| ChainError::Shape(format!("asset qty for {key}")))?
                as i128;
            // Kupo asset key: "<policyHex>.<assetNameHex>" (name may be empty).
            let (policy_hex, name_hex) = key.split_once('.').unwrap_or((key.as_str(), ""));
            out.add_mut(&hex_to_bytes(policy_hex)?, &hex_to_bytes(name_hex)?, amount);
        }
    }
    Ok(out)
}

/// Parse one Kupo match object.
pub fn parse_kupo_match(m: &Json) -> Result<KupoMatch, ChainError> {
    let tx_id = hex_to_bytes(as_str(field(m, "transaction_id")?, "match.transaction_id")?)?;
    let output_index = as_u64(field(m, "output_index")?, "match.output_index")?;
    Ok(KupoMatch {
        output_reference: OutputReference {
            transaction_id: tx_id,
            output_index,
        },
        address: as_str(field(m, "address")?, "match.address")?.to_string(),
        value: parse_kupo_value(field(m, "value")?)?,
        datum_hash: m
            .get("datum_hash")
            .and_then(|d| d.as_str())
            .map(|s| s.to_string()),
        script_hash: m
            .get("script_hash")
            .and_then(|d| d.as_str())
            .map(|s| s.to_string()),
    })
}

/// Parse a `GET /matches/...` array.
pub fn parse_kupo_matches(arr: &Json) -> Result<Vec<KupoMatch>, ChainError> {
    arr.as_array()
        .ok_or_else(|| ChainError::Shape("matches not an array".into()))?
        .iter()
        .map(parse_kupo_match)
        .collect()
}

/// Parse `GET /datums/{hash}` → the inline datum CBOR bytes. Kupo returns
/// `{"datum": "<hex>"}` (or `null` if it never stored the pre-image).
pub fn parse_kupo_datum(reply: &Json) -> Result<Vec<u8>, ChainError> {
    let d = reply
        .get("datum")
        .and_then(|d| d.as_str())
        .ok_or_else(|| ChainError::Shape("datum not found / not stored".into()))?;
    hex_to_bytes(d)
}

// ---------------------------------------------------------------------------
// The live backend.
// ---------------------------------------------------------------------------

/// Kupo + Ogmios implementation of [`ChainBackend`].
pub struct KupoOgmios {
    cfg: ValidatedConfig,
    agent: ureq::Agent,
    network: Network,
    order_addr: String,
    pool_addr: String,
}

impl KupoOgmios {
    /// Build the backend from a validated config, deriving the (bech32) order and
    /// pool addresses Kupo matches on.
    pub fn new(cfg: ValidatedConfig) -> Result<Self, ChainError> {
        let network = txaddr::network(cfg.network_id);
        let order_addr = Self::tagged_addr(network, &cfg.order_script_hash, &cfg.settlement_cred)?;
        let pool_addr = Self::tagged_addr(network, &cfg.pool_script_hash, &cfg.settlement_cred)?;
        Ok(Self {
            cfg,
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(60))
                .build(),
            network,
            order_addr,
            pool_addr,
        })
    }

    fn tagged_addr(net: Network, payment: &[u8], s: &Credential) -> Result<String, ChainError> {
        let addr = Address {
            payment: Credential::Script(payment.to_vec()),
            stake: Some(s.clone()),
        };
        txaddr::shelley_bech32(net, &addr).map_err(|e| ChainError::Address(format!("{e:?}")))
    }

    /// POST a JSON-RPC request to Ogmios.
    fn ogmios(&self, method: &str, params: Json) -> Result<Json, ChainError> {
        let body = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let resp = self
            .agent
            .post(&self.cfg.ogmios_url)
            .send_json(body)
            .or_else(|e| match e {
                // Ogmios returns JSON-RPC errors with a non-2xx status too; read it.
                ureq::Error::Status(_, r) => Ok(r),
                ureq::Error::Transport(t) => Err(ChainError::Http(t.to_string())),
            })?;
        resp.into_json::<Json>()
            .map_err(|e| ChainError::Shape(format!("ogmios json: {e}")))
    }

    /// GET a Kupo REST path (e.g. `/matches/<addr>?unspent`).
    fn kupo_get(&self, path: &str) -> Result<Json, ChainError> {
        let url = format!("{}{}", self.cfg.kupo_url.trim_end_matches('/'), path);
        let resp = self.agent.get(&url).call().map_err(|e| match e {
            ureq::Error::Status(c, _) => ChainError::Http(format!("kupo {c} on {path}")),
            ureq::Error::Transport(t) => ChainError::Http(t.to_string()),
        })?;
        resp.into_json::<Json>()
            .map_err(|e| ChainError::Shape(format!("kupo json: {e}")))
    }

    /// Fetch + decode the inline datum CBOR for a match's datum hash.
    fn fetch_datum(&self, hash: &str) -> Result<Vec<u8>, ChainError> {
        let reply = self.kupo_get(&format!("/datums/{hash}"))?;
        parse_kupo_datum(&reply)
    }

    /// The serialized byte size of the script with `hash` (hex), via Kupo
    /// `/scripts/{hash}` — the size the Conway reference-script fee is charged on.
    pub fn script_size(&self, hash: &str) -> Result<u64, ChainError> {
        let reply = self.kupo_get(&format!("/scripts/{hash}"))?;
        let s = reply
            .get("script")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ChainError::Shape(format!("script {hash} not found")))?;
        Ok((s.len() / 2) as u64)
    }

    /// Total serialized byte size of the 3 referenced validator scripts
    /// (settlement + order + pool) — the reference-script fee basis.
    pub fn ref_script_total_bytes(&self) -> Result<u64, ChainError> {
        let settlement_hash = match &self.cfg.settlement_cred {
            Credential::Script(h) | Credential::VerificationKey(h) => h.clone(),
        };
        let s = self.script_size(&hex::encode(&settlement_hash))?;
        let o = self.script_size(&hex::encode(&self.cfg.order_script_hash))?;
        let p = self.script_size(&hex::encode(&self.cfg.pool_script_hash))?;
        Ok(s + o + p)
    }

    /// All unspent matches at a bech32 address. Kupo rejects full-address path
    /// patterns (`/matches/<addr>` → "invalid pattern"), so we query the wildcard
    /// `/matches/*?unspent` — which returns only the configured, bounded set
    /// (S-tagged order/pool UTXOs + the solver wallet) — and filter by address.
    fn matches_at(&self, addr: &str) -> Result<Vec<KupoMatch>, ChainError> {
        Ok(self
            .all_unspent()?
            .into_iter()
            .filter(|m| m.address == addr)
            .collect())
    }

    /// Every unspent match in Kupo's index (the configured-pattern set).
    fn all_unspent(&self) -> Result<Vec<KupoMatch>, ChainError> {
        let reply = self.kupo_get("/matches/*?unspent")?;
        parse_kupo_matches(&reply)
    }
}

impl ChainBackend for KupoOgmios {
    type Error = ChainError;

    fn tip(&self) -> Result<Tip, ChainError> {
        parse_tip(&self.ogmios("queryNetwork/tip", json!({}))?)
    }

    fn protocol_params(&self) -> Result<ProtocolParams, ChainError> {
        parse_protocol_params(&self.ogmios("queryLedgerState/protocolParameters", json!({}))?)
    }

    fn find_orders(&self, _s: &Credential) -> Result<Vec<OrderInput>, ChainError> {
        let mut out = Vec::new();
        for m in self.matches_at(&self.order_addr)? {
            // The order script address is public: anyone can pay a datumless or
            // junk-datum UTXO there. SKIP (don't abort) anything that isn't a
            // well-formed order, so a single bad UTXO can't brick the whole batch
            // (a permissionless solver must stay live). Only a hard transport
            // error propagates.
            let r = &m.output_reference;
            let Some(hash) = m.datum_hash.as_ref() else {
                eprintln!(
                    "skip order utxo {}#{}: no datum",
                    hex::encode(&r.transaction_id),
                    r.output_index
                );
                continue;
            };
            let datum = match self
                .fetch_datum(hash)
                .and_then(|cbor| decode::order_datum_cbor(&cbor).map_err(ChainError::from))
            {
                Ok(d) => d,
                Err(e) => {
                    eprintln!(
                        "skip order utxo {}#{}: not a valid OrderDatum ({e:?})",
                        hex::encode(&r.transaction_id),
                        r.output_index
                    );
                    continue;
                }
            };
            out.push(OrderInput {
                output_reference: m.output_reference,
                address: Address {
                    payment: Credential::Script(self.cfg.order_script_hash.clone()),
                    stake: Some(self.cfg.settlement_cred.clone()),
                },
                value: m.value,
                datum,
            });
        }
        // Canonical input order (matches solver-core's `canonical_key`).
        out.sort_by(|a, b| {
            (
                &a.output_reference.transaction_id,
                a.output_reference.output_index,
            )
                .cmp(&(
                    &b.output_reference.transaction_id,
                    b.output_reference.output_index,
                ))
        });
        Ok(out)
    }

    fn find_pool(&self, nft: &AssetId) -> Result<PoolInput, ChainError> {
        for m in self.matches_at(&self.pool_addr)? {
            if m.value.quantity_of(&nft.policy, &nft.name) >= 1 {
                let hash = m
                    .datum_hash
                    .as_ref()
                    .ok_or_else(|| ChainError::Shape("pool UTXO has no datum".into()))?;
                let datum = decode::pool_datum_cbor(&self.fetch_datum(hash)?)?;
                return Ok(PoolInput {
                    output_reference: m.output_reference,
                    address: Address {
                        payment: Credential::Script(self.cfg.pool_script_hash.clone()),
                        stake: Some(self.cfg.settlement_cred.clone()),
                    },
                    value: m.value,
                    datum,
                });
            }
        }
        Err(ChainError::PoolNotFound)
    }

    fn find_wallet_utxos(&self, address: &str) -> Result<Vec<Utxo>, ChainError> {
        Ok(self
            .matches_at(address)?
            .into_iter()
            .map(|m| Utxo {
                output_reference: m.output_reference,
                value: m.value,
                has_reference_script: m.script_hash.is_some(),
                has_datum: m.datum_hash.is_some(),
            })
            .collect())
    }

    fn evaluate(&self, tx_cbor: &[u8]) -> Result<Vec<RedeemerEval>, ChainError> {
        let hex = hex::encode(tx_cbor);
        let reply = self.ogmios("evaluateTransaction", json!({"transaction": {"cbor": hex}}))?;
        parse_evaluate(&reply)
    }

    fn submit(&self, tx_cbor: &[u8]) -> Result<Vec<u8>, ChainError> {
        let hex = hex::encode(tx_cbor);
        let reply = self.ogmios("submitTransaction", json!({"transaction": {"cbor": hex}}))?;
        parse_submit(&reply)
    }
}

/// The `network_id` the backend was built for (used by the body assembler).
impl KupoOgmios {
    pub fn network(&self) -> Network {
        self.network
    }
    pub fn config(&self) -> &ValidatedConfig {
        &self.cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_tip_fixture() {
        let reply: Json =
            serde_json::from_str(include_str!("../tests/fixtures/ogmios-tip.json")).unwrap();
        let tip = parse_tip(&reply).unwrap();
        assert!(tip.slot > 100_000_000);
    }

    #[test]
    fn parses_live_protocol_params_fixture() {
        let reply: Json = serde_json::from_str(include_str!(
            "../tests/fixtures/ogmios-protocol-params.json"
        ))
        .unwrap();
        let p = parse_protocol_params(&reply).unwrap();
        assert_eq!(p.min_fee_a, 44);
        assert_eq!(p.min_fee_b, 155_381);
        assert_eq!(p.price_mem, (577, 10_000));
        assert_eq!(p.price_step, (721, 10_000_000));
        assert_eq!(p.coins_per_utxo_byte, 4_310);
        assert_eq!(p.cost_model_v3.len(), 350);
        assert_eq!(p.cost_model_v3[0], 100_788);
        assert_eq!(p.ref_script_range, 25_600);
        assert!((p.ref_script_base - 15.0).abs() < 1e-9);
    }

    #[test]
    fn parse_ratio_works() {
        assert_eq!(parse_ratio("577/10000").unwrap(), (577, 10_000));
    }

    #[test]
    fn kupo_value_with_assets() {
        let v: Json = serde_json::json!({
            "coins": 2_000_000u64,
            "assets": { "8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a.54455354": 5u64 }
        });
        let val = parse_kupo_value(&v).unwrap();
        assert_eq!(val.lovelace_of(), 2_000_000);
        let policy =
            hex_to_bytes("8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a").unwrap();
        assert_eq!(val.quantity_of(&policy, b"TEST"), 5);
    }

    #[test]
    fn parses_live_pool_match_and_datum() {
        let arr: Json =
            serde_json::from_str(include_str!("../tests/fixtures/kupo-matches.json")).unwrap();
        let matches = parse_kupo_matches(&arr).unwrap();
        // The live unspent set holds exactly one pool UTXO (carries the NFT).
        let nft_policy =
            hex_to_bytes("1c3be7b9fe09c169ae92722eac4961f1a2d94274a7669190828605d0").unwrap();
        let pool = matches
            .iter()
            .find(|m| {
                m.value
                    .quantity_of(&nft_policy, &hex_to_bytes("4e4654").unwrap())
                    == 1
            })
            .expect("a pool match with the NFT");
        assert_eq!(pool.value.lovelace_of(), 911_338_911);
        let test_policy =
            hex_to_bytes("8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a").unwrap();
        assert_eq!(pool.value.quantity_of(&test_policy, b"TEST"), 1_100_000_000);
        assert_eq!(pool.output_reference.output_index, 1);
        assert!(pool.datum_hash.is_some());

        // The inline pool datum decodes into a PoolDatum (asset_a=TEST, asset_b=ADA).
        let datum_reply: Json =
            serde_json::from_str(include_str!("../tests/fixtures/kupo-pool-datum.json")).unwrap();
        let cbor = parse_kupo_datum(&datum_reply).unwrap();
        let pd = crate::decode::pool_datum_cbor(&cbor).unwrap();
        assert_eq!(pd.asset_a.name, b"TEST");
        assert!(pd.asset_b.policy.is_empty()); // ADA
        assert_eq!((pd.fee_num, pd.fee_den), (3, 1000));
    }

    #[test]
    fn evaluate_object_form() {
        let reply = serde_json::json!({
            "jsonrpc": "2.0",
            "result": [
                {"validator": {"index": 2, "purpose": "spend"}, "budget": {"memory": 500000, "cpu": 120000000}},
                {"validator": {"index": 0, "purpose": "withdraw"}, "budget": {"memory": 800000, "cpu": 250000000}}
            ]
        });
        let evals = parse_evaluate(&reply).unwrap();
        assert_eq!(evals.len(), 2);
        assert_eq!(evals[0].purpose, Purpose::Spend);
        assert_eq!(evals[0].index, 2);
        assert_eq!(evals[1].purpose, Purpose::Withdraw);
        assert_eq!(evals[1].ex_units.steps, 250_000_000);
    }

    #[test]
    fn submit_result_parses_txid() {
        let reply = serde_json::json!({
            "jsonrpc": "2.0",
            "result": {"transaction": {"id": "6cbd9061426e1b9fb98998baae155fe1e3c54f95186ff1f9e859e8e5abfdb4da"}}
        });
        let id = parse_submit(&reply).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(id[0], 0x6c);
    }

    #[test]
    fn service_error_surfaces() {
        let reply = serde_json::json!({
            "jsonrpc": "2.0",
            "error": {"code": -32602, "message": "boom"}
        });
        assert!(matches!(parse_tip(&reply), Err(ChainError::Service(_))));
    }
}
