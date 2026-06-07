//! The live [`ChainBackend`] implementation backed by **Kupo** (UTXO discovery,
//! REST on `:1442`) and **Ogmios** (tip, protocol parameters, the `EvaluateTx`
//! pre-submit gate, and submission — JSON-RPC on `:1337`).
//!
//! This is the one provider-specific module behind the [`ChainBackend`] seam
//! (CLAUDE.md's swappable data-access rule). The JSON↔domain parsing is factored
//! into free functions that take `serde_json::Value`, so they're unit-tested
//! against fixtures captured from the live services — independently of the HTTP
//! transport, which is exercised live by the orchestrator.

use crate::backend::{
    ChainBackend, ExUnits, ProtocolParams, Purpose, RedeemerEval, ResolvedUtxo, Snapshot, Tip, Utxo,
};
use crate::config::ValidatedConfig;
use crate::decode::{self, DecodeError};
use pallas_addresses::Network;
use serde_json::{json, Value as Json};
use solver_core::output::{Address, LpIntentInput, OrderInput, PoolInput};
use solver_core::types::{Credential, OutputReference};
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

/// Parse `GET /checkpoints` → the latest indexed checkpoint slot (the list is
/// newest-first). This is the "new block indexed by Kupo" signal the loop watches.
pub fn parse_kupo_checkpoint(reply: &Json) -> Result<u64, ChainError> {
    let latest = reply
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| ChainError::Shape("empty checkpoints".into()))?;
    as_u64(field(latest, "slot_no")?, "checkpoint.slot_no")
}

/// Parse `GET /patterns` → Kupo's active match patterns (a JSON array of strings,
/// e.g. `["*/<S_HASH>", "60<solver_pkh>"]`). Used by the deployment preflight.
pub fn parse_kupo_patterns(reply: &Json) -> Result<Vec<String>, ChainError> {
    reply
        .as_array()
        .ok_or_else(|| ChainError::Shape("patterns not an array".into()))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| ChainError::Shape("pattern not a string".into()))
        })
        .collect()
}

/// Does Kupo's pattern set index THIS deployment? Every order/pool UTXO is stake-
/// tagged with the settlement credential `S` (§5.4), so the indexer must carry the
/// wildcard `*/<S_HASH>`. Pure (network-free) so it can be unit-tested.
pub fn patterns_index_settlement(patterns: &[String], settlement_hash: &str) -> bool {
    let want = format!("*/{settlement_hash}");
    patterns.iter().any(|p| p == &want)
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

/// Serialize a solver-core [`Value`] into Ogmios v6's nested value object:
/// `{ "ada": {"lovelace": N}, "<policyHex>": {"<assetNameHex>": qty, ...}, ... }`
/// (the strict object form the live service requires — see the captured fixture
/// `tests/fixtures/ogmios-evaluate-additional-utxo.json`). Quantities are
/// non-negative here (these are real outputs) and fit `u64` on Cardano.
///
/// The ADA = `(empty policy, empty name)` convention matches `solver_core::Value`
/// and `assemble::apply_assets` / `txbuild::value` — the same sentinel + group-by-
/// policy lowering, here targeting JSON rather than a Pallas value or builder output.
pub fn value_to_ogmios_json(v: &Value) -> Result<Json, ChainError> {
    use serde_json::Map;
    let mut lovelace: u64 = 0;
    // Group native assets by policy id (BTreeMap → deterministic key order).
    let mut by_policy: std::collections::BTreeMap<String, Map<String, Json>> = Default::default();
    for (policy, name, qty) in v.flatten() {
        let q = u64::try_from(qty).map_err(|_| {
            ChainError::Shape(format!(
                "negative/oversized qty {qty} in additionalUtxo value"
            ))
        })?;
        if policy.is_empty() && name.is_empty() {
            lovelace = q; // ADA
        } else {
            by_policy
                .entry(hex::encode(policy))
                .or_default()
                .insert(hex::encode(name), Json::from(q));
        }
    }
    let mut top = Map::new();
    top.insert("ada".into(), json!({ "lovelace": lovelace }));
    for (policy, names) in by_policy {
        top.insert(policy, Json::Object(names));
    }
    Ok(Json::Object(top))
}

/// Serialize one in-flight [`ResolvedUtxo`] into an Ogmios v6 `additionalUtxo`
/// entry (`{ transaction:{id}, index, address, value, datum? }`).
pub fn resolved_utxo_to_json(u: &ResolvedUtxo) -> Result<Json, ChainError> {
    let mut entry = json!({
        "transaction": { "id": hex::encode(&u.output_reference.transaction_id) },
        "index": u.output_reference.output_index,
        "address": u.address_bech32,
        "value": value_to_ogmios_json(&u.value)?,
    });
    if let Some(d) = &u.datum {
        entry["datum"] = Json::String(hex::encode(d));
    }
    Ok(entry)
}

/// Serialize the full `additionalUtxo` array for an `evaluateTransaction` call.
pub fn additional_utxo_json(additional: &[ResolvedUtxo]) -> Result<Json, ChainError> {
    Ok(Json::Array(
        additional
            .iter()
            .map(resolved_utxo_to_json)
            .collect::<Result<Vec<_>, _>>()?,
    ))
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
    /// The lp_intent **enterprise** address (payment = lp_intent script hash, stake
    /// = `None`). NOT `S`-tagged — the settlement anchor never enumerates it.
    lp_intent_addr: String,
}

impl KupoOgmios {
    /// Build the backend from a validated config, deriving the (bech32) order and
    /// pool addresses Kupo matches on (`S`-tagged), plus the lp_intent enterprise
    /// address (non-`S`-tagged).
    pub fn new(cfg: ValidatedConfig) -> Result<Self, ChainError> {
        let network = txaddr::network(cfg.network_id);
        let order_addr = Self::tagged_addr(network, &cfg.order_script_hash, &cfg.settlement_cred)?;
        let pool_addr = Self::tagged_addr(network, &cfg.pool_script_hash, &cfg.settlement_cred)?;
        let lp_intent_addr = Self::enterprise_addr(network, &cfg.lp_intent_script_hash)?;
        Ok(Self {
            cfg,
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(60))
                .build(),
            network,
            order_addr,
            pool_addr,
            lp_intent_addr,
        })
    }

    fn tagged_addr(net: Network, payment: &[u8], s: &Credential) -> Result<String, ChainError> {
        let addr = Address {
            payment: Credential::Script(payment.to_vec()),
            stake: Some(s.clone()),
        };
        txaddr::shelley_bech32(net, &addr).map_err(|e| ChainError::Address(format!("{e:?}")))
    }

    /// An **enterprise** Shelley address (payment script credential, no stake) — the
    /// shape of the lp_intent UTXO address. Distinct from [`tagged_addr`], which
    /// attaches the `S` stake credential; an lp_intent UTXO must never be `S`-tagged
    /// (else the settlement anchor would try to enumerate it as an order/pool).
    fn enterprise_addr(net: Network, payment: &[u8]) -> Result<String, ChainError> {
        let addr = Address {
            payment: Credential::Script(payment.to_vec()),
            stake: None,
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

    /// Total serialized byte size of the 2 scripts a fulfillment references (pool +
    /// lp_intent) — the reference-script fee basis for an LP fulfillment tx. Errors
    /// if the lp_intent script isn't indexed yet (not deployed pre-Phase-4); the
    /// orchestrator treats that as "LP fulfillment disabled this session".
    pub fn lp_fulfillment_ref_bytes(&self) -> Result<u64, ChainError> {
        let p = self.script_size(&hex::encode(&self.cfg.pool_script_hash))?;
        let l = self.script_size(&hex::encode(&self.cfg.lp_intent_script_hash))?;
        Ok(p + l)
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

    /// Kupo's latest indexed checkpoint slot — a cheap "has a new block been
    /// indexed?" probe. The orchestrator loop watches this so it does a full
    /// discover/settle pass exactly once per new block (and only after Kupo has
    /// the block's data), rather than on a blind fixed timer.
    pub fn kupo_checkpoint(&self) -> Result<u64, ChainError> {
        parse_kupo_checkpoint(&self.kupo_get("/checkpoints")?)
    }

    /// Kupo's active match patterns (`GET /patterns`).
    pub fn kupo_patterns(&self) -> Result<Vec<String>, ChainError> {
        parse_kupo_patterns(&self.kupo_get("/patterns")?)
    }

    /// Preflight: confirm the connected Kupo is indexing THIS deployment — its
    /// patterns must include `*/<settlement_hash>` (every order/pool UTXO is stake-
    /// tagged with `S`, §5.4). A **redeploy changes `S`**, so a Kupo still indexing a
    /// prior deployment would silently surface zero pools; we fail fast with a
    /// remediation hint instead. (Kupo owns its own db — rebuilding a stale index is
    /// `run-kupo.sh`'s job, which auto-detects this and rebuilds; or `KUPO_RESET=1`.)
    pub fn preflight_deployment(&self, settlement_hash: &str) -> Result<(), ChainError> {
        let have = self.kupo_patterns()?;
        if patterns_index_settlement(&have, settlement_hash) {
            Ok(())
        } else {
            Err(ChainError::Service(format!(
                "Kupo is not indexing this deployment: expected pattern `*/{settlement_hash}`, \
                 but Kupo's patterns are {have:?}. Its index is for a different (stale) \
                 deployment — rebuild it: re-run `run-kupo.sh` (it auto-rebuilds a stale \
                 index), or wipe with `KUPO_RESET=1`."
            )))
        }
    }

    /// Decode a match at the order address into an [`OrderInput`], or `None`
    /// (logged) if it isn't a well-formed order. The order script address is
    /// public — anyone can park a datumless/junk UTXO there — so a bad UTXO is
    /// skipped, never fatal (a permissionless solver must stay live).
    fn try_order(&self, m: &KupoMatch) -> Option<OrderInput> {
        let r = &m.output_reference;
        let skip = |why: String| {
            // Junk at the public order address is expected; debug, not warn,
            // so it doesn't spam every block.
            tracing::debug!(
                utxo = format!("{}#{}", hex::encode(&r.transaction_id), r.output_index),
                "skip order utxo: {why}"
            );
        };
        let Some(hash) = m.datum_hash.as_ref() else {
            skip("no datum".into());
            return None;
        };
        match self
            .fetch_datum(hash)
            .and_then(|cbor| decode::order_datum_cbor(&cbor).map_err(ChainError::from))
        {
            Ok(datum) => Some(OrderInput {
                output_reference: r.clone(),
                address: Address {
                    payment: Credential::Script(self.cfg.order_script_hash.clone()),
                    stake: Some(self.cfg.settlement_cred.clone()),
                },
                value: m.value.clone(),
                datum,
            }),
            Err(e) => {
                skip(format!("not a valid OrderDatum ({e:?})"));
                None
            }
        }
    }

    /// Decode a match at the pool address into a [`PoolInput`], or `None` (logged)
    /// if it isn't a well-formed pool. NFT-agnostic: the pool self-describes its
    /// pair + NFT via its `PoolDatum`; we accept it iff it has a valid datum AND
    /// actually holds the NFT it declares (so any number of pairs are discovered
    /// with no per-pool config, and a junk UTXO at the pool address is skipped).
    fn try_pool(&self, m: &KupoMatch) -> Option<PoolInput> {
        let r = &m.output_reference;
        let datum = match m
            .datum_hash
            .as_ref()
            .ok_or_else(|| ChainError::Shape("no datum".into()))
            .and_then(|h| self.fetch_datum(h))
            .and_then(|cbor| decode::pool_datum_cbor(&cbor).map_err(ChainError::from))
        {
            Ok(d) => d,
            // No datum / not a PoolDatum → not a pool; skip quietly (the pool
            // address only ever holds pools in practice, but be defensive).
            Err(_) => return None,
        };
        // Must hold exactly the NFT it declares (else it's malformed/an attack).
        if m.value.quantity_of(&datum.nft.policy, &datum.nft.name) < 1 {
            tracing::warn!(
                utxo = format!("{}#{}", hex::encode(&r.transaction_id), r.output_index),
                "skip pool utxo: datum declares an NFT it doesn't hold"
            );
            return None;
        }
        Some(PoolInput {
            output_reference: r.clone(),
            address: Address {
                payment: Credential::Script(self.cfg.pool_script_hash.clone()),
                stake: Some(self.cfg.settlement_cred.clone()),
            },
            value: m.value.clone(),
            datum,
        })
    }

    /// Decode a match at the lp_intent address into an [`LpIntentInput`], or `None`
    /// (logged) if it isn't a well-formed intent. Like the order address, the
    /// lp_intent address is public — anyone can park junk there — so a bad UTXO is
    /// skipped, never fatal. The address is **enterprise** (stake `None`), so the
    /// decoded input carries `stake: None` (never the `S` tag).
    fn try_lp_intent(&self, m: &KupoMatch) -> Option<LpIntentInput> {
        let r = &m.output_reference;
        let skip = |why: String| {
            tracing::debug!(
                utxo = format!("{}#{}", hex::encode(&r.transaction_id), r.output_index),
                "skip lp_intent utxo: {why}"
            );
        };
        let Some(hash) = m.datum_hash.as_ref() else {
            skip("no datum".into());
            return None;
        };
        match self
            .fetch_datum(hash)
            .and_then(|cbor| decode::lp_intent_datum_cbor(&cbor).map_err(ChainError::from))
        {
            Ok(datum) => Some(LpIntentInput {
                output_reference: r.clone(),
                address: Address {
                    payment: Credential::Script(self.cfg.lp_intent_script_hash.clone()),
                    stake: None,
                },
                value: m.value.clone(),
                datum,
            }),
            Err(e) => {
                skip(format!("not a valid LpIntentDatum ({e:?})"));
                None
            }
        }
    }

    /// Canonical input order, matching solver-core's `canonical_key`.
    fn sort_orders(orders: &mut [OrderInput]) {
        orders.sort_by(|a, b| {
            (
                &a.output_reference.transaction_id,
                a.output_reference.output_index,
            )
                .cmp(&(
                    &b.output_reference.transaction_id,
                    b.output_reference.output_index,
                ))
        });
    }
}

fn wallet_utxo(m: &KupoMatch) -> Utxo {
    Utxo {
        output_reference: m.output_reference.clone(),
        value: m.value.clone(),
        has_reference_script: m.script_hash.is_some(),
        has_datum: m.datum_hash.is_some(),
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
        let mut out: Vec<OrderInput> = self
            .matches_at(&self.order_addr)?
            .iter()
            .filter_map(|m| self.try_order(m))
            .collect();
        Self::sort_orders(&mut out);
        Ok(out)
    }

    fn find_pools(&self) -> Result<Vec<PoolInput>, ChainError> {
        Ok(self
            .matches_at(&self.pool_addr)?
            .iter()
            .filter_map(|m| self.try_pool(m))
            .collect())
    }

    fn find_lp_intents(&self) -> Result<Vec<LpIntentInput>, ChainError> {
        Ok(self
            .matches_at(&self.lp_intent_addr)?
            .iter()
            .filter_map(|m| self.try_lp_intent(m))
            .collect())
    }

    fn find_wallet_utxos(&self, address: &str) -> Result<Vec<Utxo>, ChainError> {
        Ok(self.matches_at(address)?.iter().map(wallet_utxo).collect())
    }

    /// Override the default (three separate fetches) with ONE `/matches/*?unspent`
    /// call partitioned by address — an atomic snapshot (no inter-call chain drift)
    /// and a third of the Kupo round-trips per pass. Discovers EVERY pool (one per
    /// pair) and EVERY order with no per-pool config.
    fn discover(&self, _s: &Credential, wallet_addr: &str) -> Result<Snapshot, ChainError> {
        let all = self.all_unspent()?;
        let mut orders = Vec::new();
        let mut pools = Vec::new();
        let mut lp_intents = Vec::new();
        let mut wallet = Vec::new();
        for m in &all {
            if m.address == self.order_addr {
                if let Some(o) = self.try_order(m) {
                    orders.push(o);
                }
            } else if m.address == self.pool_addr {
                if let Some(p) = self.try_pool(m) {
                    pools.push(p);
                }
            } else if m.address == self.lp_intent_addr {
                if let Some(i) = self.try_lp_intent(m) {
                    lp_intents.push(i);
                }
            } else if m.address == wallet_addr {
                wallet.push(wallet_utxo(m));
            }
        }
        Self::sort_orders(&mut orders);
        Ok(Snapshot {
            orders,
            pools,
            lp_intents,
            wallet,
        })
    }

    fn evaluate(
        &self,
        tx_cbor: &[u8],
        additional: &[ResolvedUtxo],
    ) -> Result<Vec<RedeemerEval>, ChainError> {
        let hex = hex::encode(tx_cbor);
        let mut params = json!({ "transaction": { "cbor": hex } });
        // Only attach `additionalUtxo` when chaining (resolving an unconfirmed
        // ancestor) — a standalone tx resolves entirely from ledger state.
        if !additional.is_empty() {
            params["additionalUtxo"] = additional_utxo_json(additional)?;
        }
        let reply = self.ogmios("evaluateTransaction", params)?;
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
    fn parses_live_checkpoint_fixture() {
        let reply: Json =
            serde_json::from_str(include_str!("../tests/fixtures/kupo-checkpoints.json")).unwrap();
        // newest-first: the first entry's slot is the latest.
        assert_eq!(parse_kupo_checkpoint(&reply).unwrap(), 124_659_676);
        assert!(matches!(
            parse_kupo_checkpoint(&serde_json::json!([])),
            Err(ChainError::Shape(_))
        ));
    }

    #[test]
    fn preflight_detects_stale_vs_matching_patterns() {
        let reply: Json =
            serde_json::from_str(include_str!("../tests/fixtures/kupo-patterns.json")).unwrap();
        let patterns = parse_kupo_patterns(&reply).unwrap();
        assert_eq!(patterns.len(), 2);
        // the deployment's S is indexed (the `*/<S>` wildcard is present) -> OK.
        assert!(patterns_index_settlement(
            &patterns,
            "a57de7a9191ab5544173287119f7203724c2d7a7b0457d367545211e"
        ));
        // a different deployment's S (e.g. the prior one) is NOT indexed -> stale.
        assert!(!patterns_index_settlement(
            &patterns,
            "82039119bc85e1b8fb4fab8cfb0628f487e64f0b6338da842950500c"
        ));
        // a non-array body is a shape error, not a silent pass.
        assert!(matches!(
            parse_kupo_patterns(&serde_json::json!({})),
            Err(ChainError::Shape(_))
        ));
    }

    #[test]
    fn parse_ratio_works() {
        assert_eq!(parse_ratio("577/10000").unwrap(), (577, 10_000));
    }

    #[test]
    fn lp_intent_addr_is_enterprise_and_distinct_from_tagged() {
        let net = Network::Testnet;
        let s = Credential::Script(vec![0x55u8; 28]);
        let lp_hash = vec![0xaau8; 28];
        let lp = KupoOgmios::enterprise_addr(net, &lp_hash).unwrap();
        // Enterprise = payment-only Shelley addr; the `S`-tagged form embeds a stake
        // credential, so it must differ even for the SAME payment hash.
        let tagged = KupoOgmios::tagged_addr(net, &lp_hash, &s).unwrap();
        assert_ne!(lp, tagged);
        // Re-derive via the address lib and confirm the stake half is absent.
        let parsed = pallas_addresses::Address::from_bech32(&lp).unwrap();
        match parsed {
            pallas_addresses::Address::Shelley(sh) => {
                assert!(matches!(
                    sh.delegation(),
                    pallas_addresses::ShelleyDelegationPart::Null
                ));
            }
            other => panic!("expected a shelley address, got {other:?}"),
        }
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
    fn value_to_ogmios_json_groups_by_policy() {
        let policy =
            hex_to_bytes("8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a").unwrap();
        let v = Value::from_lovelace(5_000_000).add(&policy, b"TEST", 100);
        let j = value_to_ogmios_json(&v).unwrap();
        // ADA lives under "ada":{"lovelace":N}; native assets under the policy hex.
        assert_eq!(j["ada"]["lovelace"], serde_json::json!(5_000_000));
        assert_eq!(
            j["8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a"]["54455354"],
            serde_json::json!(100)
        );
    }

    #[test]
    fn value_to_ogmios_json_ada_only_has_zero_safe_shape() {
        let j = value_to_ogmios_json(&Value::from_lovelace(2_000_000)).unwrap();
        assert_eq!(j, serde_json::json!({ "ada": { "lovelace": 2_000_000 } }));
        // a negative quantity (shouldn't occur for a real output) is rejected.
        let neg = Value::zero().add(&[], &[], -1);
        assert!(value_to_ogmios_json(&neg).is_err());
    }

    #[test]
    fn resolved_utxo_to_json_matches_captured_shape() {
        // Mirror the live-captured request entry exactly (fixture: the request
        // shape Ogmios v6 strictly validated as well-formed before tx decode).
        let policy =
            hex_to_bytes("8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a").unwrap();
        let u = ResolvedUtxo {
            output_reference: OutputReference {
                transaction_id: vec![0u8; 32],
                output_index: 3,
            },
            address_bech32: "addr_test1vq6vymyr2plj92javazvvxfqj5aaqxhk5u3u87ud4dc8u5gyasnly"
                .into(),
            value: Value::from_lovelace(5_000_000).add(&policy, b"TEST", 100),
            datum: Some(hex_to_bytes("d87980").unwrap()),
        };
        let got = resolved_utxo_to_json(&u).unwrap();
        let want = serde_json::json!({
            "transaction": { "id": "0000000000000000000000000000000000000000000000000000000000000000" },
            "index": 3,
            "address": "addr_test1vq6vymyr2plj92javazvvxfqj5aaqxhk5u3u87ud4dc8u5gyasnly",
            "value": {
                "ada": { "lovelace": 5_000_000 },
                "8160c878d40c39d7bfeb300560343d646620ab50182981efa8ae779a": { "54455354": 100 }
            },
            "datum": "d87980"
        });
        assert_eq!(got, want);
    }

    #[test]
    fn resolved_utxo_to_json_omits_absent_datum() {
        let u = ResolvedUtxo {
            output_reference: OutputReference {
                transaction_id: vec![0xab; 32],
                output_index: 0,
            },
            address_bech32: "addr_test1vq6vymyr2plj92javazvvxfqj5aaqxhk5u3u87ud4dc8u5gyasnly"
                .into(),
            value: Value::from_lovelace(7_000_000),
            datum: None,
        };
        let got = resolved_utxo_to_json(&u).unwrap();
        // a solver-change output carries no datum → the field is absent.
        assert!(got.get("datum").is_none());
        assert_eq!(got["index"], serde_json::json!(0));
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
