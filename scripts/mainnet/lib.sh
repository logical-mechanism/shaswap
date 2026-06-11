# lib.sh — shared library for the ShaSwap MAINNET deploy scripts. SOURCE it; do not run.
#
# One home for the config, the audited hashes, the chain helpers, and the four deploy
# steps (verify_build / register_s / publish_refs / verify_onchain). Both the all-in-one
# scripts/deploy-mainnet.sh and the human-paced scripts/mainnet/0N-*.sh source this, so the
# confirmation-wait, idempotency, and verification logic lives in exactly ONE place.
#
# Every step is MAINNET-ONLY and idempotent: re-running skips work already on-chain and
# waits for confirmation before returning, so an interrupted deploy is recovered by simply
# re-running the step (or the orchestrator).
set -euo pipefail

# Refuse to be executed directly (it only defines things).
[ "${BASH_SOURCE[0]:-}" != "${0:-}" ] || { echo "lib.sh must be SOURCED, not run." >&2; exit 1; }

MAINNET_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$MAINNET_LIB_DIR/../.." && pwd)"
CONTRACTS="$REPO/contracts"
SCRIPTS_DIR="$CONTRACTS/happy_path/scripts"   # the audited, committed .plutus files
WORK="$REPO/scripts/work-mainnet"             # tx drafts + refs.json (gitignored); shared handoff
mkdir -p "$WORK"

# Committed identities (must equal contracts/plutus.json + constants.ak; pinned by the
# app's address.test.ts). Deploy REFUSES bytecode whose hash differs. lp_intent is the
# fifth, additive immutable hash (Rev 22). The POOL hash is the **Rev 29 H-01 fork** pool
# (`pool_settle` S-tag self-check + held-LP pin); settlement/order/lp_intent are byte-
# identical to the Rev 25 set. The mainnet H-01 fork is a PARTIAL fork — publish ONLY the
# new pool ref (`fork_pool_ref` / `02b-fork-pool-ref.sh`); the existing settlement/order/
# lp_intent refs (deploy d56e729c) stay. `publish_refs`/`verify_onchain` below are the
# FULL from-scratch deploy (already done on mainnet) — do NOT run them for the fork.
S_HASH="a305a3cfd8343c03abffa0ef2b3ab6c756557a0dc5fb298c747259ea"      # settlement = stake cred S
ORDER_HASH="e7fa1a385a04c103ece6746bc15b8e71cdf1ccb6854dbd3524fb148d"  # order(S)
POOL_HASH="757ba6b73922bc98824661bf4deb90e6a061041705c032ace755afd3"   # pool(S) — Rev 29 (H-01 fork; was 34b30c7a)
LP_INTENT_HASH="fa885b037442ac10e65e7b1aeb6056f350446446ea51d92878240e5d"  # lp_intent(S) — Rev 25

SETTLEMENT_SCRIPT="$SCRIPTS_DIR/settlement.plutus"
ORDER_SCRIPT="$SCRIPTS_DIR/order.plutus"
POOL_SCRIPT="$SCRIPTS_DIR/pool.plutus"
LP_INTENT_SCRIPT="$SCRIPTS_DIR/lp_intent.plutus"

cli() { cardano-cli latest "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
txid() {
  cli transaction txid --tx-file "$1" \
    | python3 -c "import sys,json;s=sys.stdin.read().strip();print(json.loads(s)['txhash'] if s.startswith('{') else s)"
}

# Guards shared by every entry point. Call once at the top of each script.
preflight() {
  [ "${MAINNET_CONFIRM:-}" = "I_UNDERSTAND_THIS_IS_IRREVERSIBLE" ] \
    || die "set MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE to proceed (immutable deploy)."
  command -v cardano-cli >/dev/null || die "cardano-cli not found on PATH."
  cardano-cli latest --help >/dev/null 2>&1 || die "this cardano-cli lacks the era-grouped 'latest' command group (need v8.20+/v11+)."
  command -v python3 >/dev/null || die "python3 not found on PATH (the deploy helpers parse chain JSON with it)."
  [ -n "${CARDANO_NODE_SOCKET_PATH:-}" ] && [ -S "$CARDANO_NODE_SOCKET_PATH" ] \
    || die "CARDANO_NODE_SOCKET_PATH must point at a running node socket."
  : "${DEPLOY_SKEY:?set DEPLOY_SKEY to the funded mainnet signing key}"
  : "${DEPLOY_ADDR:?set DEPLOY_ADDR to the funded mainnet address}"
  [ -f "$DEPLOY_SKEY" ] || die "DEPLOY_SKEY file not found: $DEPLOY_SKEY"
  case "$DEPLOY_ADDR" in addr1*) : ;; *) die "DEPLOY_ADDR is not a mainnet (addr1…) address: $DEPLOY_ADDR";; esac
  cli query protocol-parameters --mainnet >/dev/null 2>&1 \
    || die "node did not answer a --mainnet query; is this a mainnet node?"
}

# Block until a submitted tx's outputs are visible in the LEDGER (not just the mempool) —
# `cli query utxo` reflects the confirmed tip, so without this the next step would re-query
# pre-spend state and re-select an already-spent input. Polls ~15 min, then gives up (the
# scripts are resumable: just re-run).
wait_for_tx() {
  local t="$1" label="$2" i=0
  echo "    waiting for $label tx $t to confirm…"
  while [ "$i" -lt 90 ]; do
    if cli query utxo --address "$DEPLOY_ADDR" --mainnet --output-json \
         | python3 -c "import sys,json;u=json.load(sys.stdin);sys.exit(0 if any(k.split('#',1)[0]=='$t' for k in u) else 1)"; then
      echo "    confirmed: $t"; return 0
    fi
    sleep 10; i=$((i + 1))
  done
  die "$label tx $t not confirmed after ~15 min; check the node, then re-run (it resumes)."
}

# The hash of the reference script carried by a UTXO, derived by re-hashing the on-chain
# script CBOR with `transaction policyid` — NOT read from a (nonexistent) utxo JSON field.
# Prints the 56-hex hash, or empty if the UTXO carries no reference script / doesn't exist.
ref_hash() {
  cli query utxo --tx-in "$1" --mainnet --output-json 2>/dev/null \
    | python3 -c "
import sys,json
u=json.load(sys.stdin)
s=(next(iter(u.values()),{}).get('referenceScript') or {}).get('script')
if not s: sys.exit(1)
open('$WORK/_refchk.plutus','w').write(json.dumps(s))" 2>/dev/null \
    && cli transaction policyid --script-file "$WORK/_refchk.plutus" 2>/dev/null || true
}

# Funding input = the largest UTXO (sets $TXIN). Collateral = the smallest ada-only UTXO
# distinct from it (sets $COLL); collateral is returned on success and must be pure-ADA and
# disjoint from the inputs.
pick_funding() {
  TXIN=$(cli query utxo --address "$DEPLOY_ADDR" --mainnet --output-json \
    | python3 -c "import sys,json;u=json.load(sys.stdin);(print(max(u,key=lambda k:u[k]['value'].get('lovelace',0))) if u else sys.exit('no UTXOs'))") \
    || die "no UTXOs at $DEPLOY_ADDR — fund the wallet and re-run."
}
pick_collateral() {
  COLL=$(cli query utxo --address "$DEPLOY_ADDR" --mainnet --output-json \
    | python3 -c "
import sys,json
u=json.load(sys.stdin)
ada=sorted((k for k,v in u.items() if list(v['value'])==['lovelace'] and k!='$TXIN'), key=lambda k:u[k]['value']['lovelace'])
(print(ada[0]) if ada else sys.exit('NO_COLLATERAL'))") \
    || die "need a 2nd ada-only UTXO for collateral, distinct from the funding input — split your wallet into 2+ ada-only UTXOs and re-run."
}

_verify_hash() { # <file> <expected-hash> <label>
  local got; got=$(cli transaction policyid --script-file "$1") || die "could not hash $3 script ($1)"
  [ "$got" = "$2" ] || die "$3 hash mismatch: deployed $got != audited $2 (wrong/edited bytecode)."
  echo "    ok  $3 = $2"
}

# ── Step 0 ───────────────────────────────────────────────────────────────────────────
verify_build() {
  command -v aiken >/dev/null || die "aiken not found on PATH (needed for the reproducibility check)."
  echo "==> [0] verifying reproducible build + script hashes"
  ( cd "$CONTRACTS" && aiken build >/dev/null && git diff --exit-code plutus.json >/dev/null ) \
    || die "plutus.json is not reproducible from source — refusing to deploy drifted artifacts."
  _verify_hash "$SETTLEMENT_SCRIPT" "$S_HASH" settlement
  _verify_hash "$ORDER_SCRIPT" "$ORDER_HASH" order
  _verify_hash "$POOL_SCRIPT" "$POOL_HASH" pool
  _verify_hash "$LP_INTENT_SCRIPT" "$LP_INTENT_HASH" lp_intent
}

# ── Step 1: register the settlement stake credential S (idempotent) ──────────────────
register_s() {
  echo "==> [1] registering settlement stake credential S"
  local s_stake; s_stake=$(cli stake-address build --stake-script-file "$SETTLEMENT_SCRIPT" --mainnet)
  if cli query stake-address-info --address "$s_stake" --mainnet --output-json 2>/dev/null \
       | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if isinstance(d,list) and len(d)>0 else 1)"; then
    echo "    S already registered ($s_stake) — skipping."; return 0
  fi
  cli query protocol-parameters --mainnet --out-file "$WORK/pparams.json"
  local dep; dep=$(python3 -c "import json;print(json.load(open('$WORK/pparams.json'))['stakeAddressDeposit'])")
  echo '{"constructor":0,"fields":[]}' > "$WORK/unit.json"
  cli stake-address registration-certificate \
    --stake-script-file "$SETTLEMENT_SCRIPT" --key-reg-deposit-amt "$dep" --out-file "$WORK/s.reg.cert"
  pick_funding; pick_collateral
  echo "    input=$TXIN  collateral=$COLL"
  cli transaction build --tx-in "$TXIN" --tx-in-collateral "$COLL" --change-address "$DEPLOY_ADDR" \
    --certificate-file "$WORK/s.reg.cert" --certificate-script-file "$SETTLEMENT_SCRIPT" \
    --certificate-redeemer-file "$WORK/unit.json" --mainnet --out-file "$WORK/s.reg.tx"
  cli transaction sign --tx-file "$WORK/s.reg.tx" --signing-key-file "$DEPLOY_SKEY" \
    --mainnet --out-file "$WORK/s.reg.signed"
  local rt; rt=$(txid "$WORK/s.reg.signed")
  cli transaction submit --tx-file "$WORK/s.reg.signed" --mainnet
  echo "    S registration submitted: $rt"
  wait_for_tx "$rt" "S registration"
}

# ── Step 2: publish reference scripts (settlement #0, pool #1, order #2) — idempotent ─
publish_refs() {
  echo "==> [2] publishing reference scripts"
  local rtxid=""
  [ -f "$WORK/refs.json" ] && rtxid=$(python3 -c "import json;print(json.load(open('$WORK/refs.json')).get('settlement_ref',{}).get('tx_id',''))" 2>/dev/null || true)
  if [ -n "$rtxid" ] && [ "$(ref_hash "$rtxid#0")" = "$S_HASH" ]; then
    echo "    refs already on-chain in $rtxid — skipping."; return 0
  fi
  pick_funding   # fresh: after the step-1 wait the change UTXO is confirmed & spendable
  echo "    input=$TXIN"
  cli transaction build --tx-in "$TXIN" \
    --tx-out "$DEPLOY_ADDR+60000000" --tx-out-reference-script-file "$SETTLEMENT_SCRIPT" \
    --tx-out "$DEPLOY_ADDR+30000000" --tx-out-reference-script-file "$POOL_SCRIPT" \
    --tx-out "$DEPLOY_ADDR+15000000" --tx-out-reference-script-file "$ORDER_SCRIPT" \
    --tx-out "$DEPLOY_ADDR+25000000" --tx-out-reference-script-file "$LP_INTENT_SCRIPT" \
    --change-address "$DEPLOY_ADDR" --mainnet --out-file "$WORK/refs.tx"
  cli transaction sign --tx-file "$WORK/refs.tx" --signing-key-file "$DEPLOY_SKEY" \
    --mainnet --out-file "$WORK/refs.signed"
  rtxid=$(txid "$WORK/refs.signed")
  cli transaction submit --tx-file "$WORK/refs.signed" --mainnet
  python3 - "$rtxid" > "$WORK/refs.json" <<'PY'
import sys, json
t = sys.argv[1]
json.dump({"settlement_ref": {"tx_id": t, "index": 0},
           "pool_ref":       {"tx_id": t, "index": 1},
           "order_ref":      {"tx_id": t, "index": 2},
           "lp_intent_ref":  {"tx_id": t, "index": 3}}, sys.stdout, indent=2)
PY
  echo "    reference scripts submitted in tx $rtxid  (settlement=#0, pool=#1, order=#2, lp_intent=#3)"
  echo "    refs written to $WORK/refs.json"
  wait_for_tx "$rtxid" "reference scripts"
}

# ── Step 3: verify on-chain (re-hash deployed scripts; must match audited hashes) ─────
# Prints "REFS_TXID=<txid>" on success for the operator to wire into the clients.
verify_onchain() {
  echo "==> [3] verifying on-chain"
  [ -f "$WORK/refs.json" ] || die "no $WORK/refs.json — run 02-deploy-refs.sh (or deploy-mainnet.sh) first."
  local rtxid; rtxid=$(python3 -c "import json;print(json.load(open('$WORK/refs.json'))['settlement_ref']['tx_id'])")
  local failed=0 pair rest ref want label got
  for pair in "$rtxid#0:$S_HASH:settlement" "$rtxid#1:$POOL_HASH:pool" "$rtxid#2:$ORDER_HASH:order" "$rtxid#3:$LP_INTENT_HASH:lp_intent"; do
    ref="${pair%%:*}"; rest="${pair#*:}"; want="${rest%%:*}"; label="${rest#*:}"
    got=$(ref_hash "$ref")
    if [ "$got" = "$want" ]; then echo "    ok  $label ref $ref carries $want";
    else echo "    !!  $label ref $ref hash='$got' (expected $want)"; failed=1; fi
  done
  [ "$failed" = 0 ] || die "on-chain verification FAILED — deployed refs do not match audited hashes (re-run to re-verify)."
  echo "REFS_TXID=$rtxid"
}

# ── PARTIAL FORK (H-01, Rev 29): publish ONLY the new pool reference script ────────────
# Only the `pool` validator changed, so we add a single new pool ref and LEAVE the existing
# settlement/order/lp_intent refs (deploy d56e729c) in place. Idempotent: if a UTXO at
# DEPLOY_ADDR already carries a ref script hashing to POOL_HASH, it records that and makes
# NO new tx. Self-verifies the on-chain ref hash before recording, and writes
# $WORK/pool-ref.json { tx_id, index } for wiring into the app + batcher config.

# Print the txid#idx of a DEPLOY_ADDR UTXO whose reference script hashes to POOL_HASH (the
# new pool), or nothing. Scans only ref-script-bearing UTXOs; re-hashes each via ref_hash.
_find_pool_ref() {
  local k
  for k in $(cli query utxo --address "$DEPLOY_ADDR" --mainnet --output-json \
      | python3 -c "import sys,json;u=json.load(sys.stdin);print('\n'.join(k for k,v in u.items() if v.get('referenceScript')))"); do
    if [ "$(ref_hash "$k")" = "$POOL_HASH" ]; then echo "$k"; return 0; fi
  done
}

_write_pool_ref() { # <txid#idx>
  python3 - "${1%%#*}" "${1##*#}" > "$WORK/pool-ref.json" <<'PY'
import sys, json
json.dump({"pool_ref": {"tx_id": sys.argv[1], "index": int(sys.argv[2])}}, sys.stdout, indent=2)
PY
  echo "    wrote $WORK/pool-ref.json"
}

fork_pool_ref() {
  echo "==> [fork] publishing the NEW pool reference script (partial fork — pool only)"
  # The local pool.plutus MUST be the audited H-01 pool before we spend a single lovelace.
  _verify_hash "$POOL_SCRIPT" "$POOL_HASH" pool

  local existing; existing=$(_find_pool_ref)
  if [ -n "$existing" ]; then
    echo "    pool ref already on-chain at $existing — recording, no new tx."
    _write_pool_ref "$existing"; return 0
  fi

  pick_funding
  # `pick_funding` selects the single LARGEST ada UTXO as the sole input, so we need ONE
  # UTXO that covers the 40 ADA ref output + fee + min-ada change (~42 ADA). Check it up
  # front and fail with guidance, rather than letting `transaction build` emit a raw
  # "balance is negative" error (or worse, a wallet with enough TOTAL ada but fragmented
  # across small UTXOs picking one that's too small). Nothing is signed/submitted on failure.
  local have
  have=$(cli query utxo --tx-in "$TXIN" --mainnet --output-json \
    | python3 -c "import sys,json;print(next(iter(json.load(sys.stdin).values()))['value']['lovelace'])")
  [ "$have" -ge 42000000 ] \
    || die "funding UTXO $TXIN holds only $((have / 1000000)) ADA; need a single ada-only UTXO of ~42+ ADA (40 locked in the recoverable ref + fee + change). Consolidate the wallet into one larger ada UTXO and re-run (idempotent)."
  echo "    input=$TXIN ($((have / 1000000)) ADA)"
  # One output: the new pool ref locked at DEPLOY_ADDR (recoverable). 40 ADA covers the
  # ~3 kB ref-script min-UTXO with margin; the rest returns as change.
  cli transaction build --tx-in "$TXIN" \
    --tx-out "$DEPLOY_ADDR+40000000" --tx-out-reference-script-file "$POOL_SCRIPT" \
    --change-address "$DEPLOY_ADDR" --mainnet --out-file "$WORK/poolref.tx"
  cli transaction sign --tx-file "$WORK/poolref.tx" --signing-key-file "$DEPLOY_SKEY" \
    --mainnet --out-file "$WORK/poolref.signed"
  local ptx; ptx=$(txid "$WORK/poolref.signed")
  cli transaction submit --tx-file "$WORK/poolref.signed" --mainnet
  echo "    submitted pool ref in tx $ptx"
  wait_for_tx "$ptx" "pool ref"

  local ref; ref=$(_find_pool_ref)
  [ -n "$ref" ] || die "submitted $ptx but could not locate the pool ref UTXO after confirmation."
  [ "$(ref_hash "$ref")" = "$POOL_HASH" ] || die "on-chain ref $ref hash != $POOL_HASH — aborting."
  _write_pool_ref "$ref"
  echo "    pool ref VERIFIED on-chain: $ref carries $POOL_HASH"
}
