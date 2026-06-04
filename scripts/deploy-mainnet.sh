#!/usr/bin/env bash
#
# deploy-mainnet.sh — deploy ShaSwap's immutable validators to Cardano MAINNET.
#
# This is a ONE-SHOT, NO-TAKE-BACKS operation: the validators can never be patched. The
# script is deliberately guarded — it refuses to run without explicit confirmation, it
# verifies the build is reproducible and the bytecode matches the audited source BEFORE
# touching the chain, and it verifies the result on-chain afterwards.
#
# It mirrors the preprod bootstrap (contracts/happy_path/01-register-s.sh + 02-deploy-refs.sh)
# with `--mainnet` and mainnet safety rails. The validators are network-independent (a
# script hash is the hash of its compiled code), so the SAME audited scripts deploy here.
#
# Prerequisites (operator-supplied; nothing secret lives in the repo):
#   - A synced MAINNET cardano-node; CARDANO_NODE_SOCKET_PATH points at its socket.
#   - cardano-cli (era-grouped, v11+) on PATH.
#   - A funded mainnet wallet: DEPLOY_SKEY (signing key) + DEPLOY_ADDR (its address),
#     with enough ADA for the stake deposit + three reference-script UTXOs (~110 ADA) + fees.
#
# Run:
#   CARDANO_NODE_SOCKET_PATH=/path/node.socket \
#   DEPLOY_SKEY=/secure/mainnet.skey DEPLOY_ADDR=$(cat /secure/mainnet.addr) \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE \
#   scripts/deploy-mainnet.sh
#
# See documentation/launch/mainnet-checklist.md for the full go-live gate.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
CONTRACTS="$REPO/contracts"
SCRIPTS_DIR="$CONTRACTS/happy_path/scripts"   # the audited, committed .plutus files
WORK="$REPO/scripts/work-mainnet"             # tx drafts + refs.json (gitignored)
mkdir -p "$WORK"

# Committed identities (must equal contracts/plutus.json + constants.ak; pinned by the
# app's address.test.ts). The script will REFUSE to deploy bytecode whose hash differs.
S_HASH="a57de7a9191ab5544173287119f7203724c2d7a7b0457d367545211e"      # settlement = stake cred S
ORDER_HASH="801c7a4c4268b986d0dfd90010ee5d5708c18b19be485b53e88d22f2"  # order(S)
POOL_HASH="4427ef8453f1acb4fac3844fbc7c34852fe188e4ab99f3fda07b533b"   # pool(S)

SETTLEMENT_SCRIPT="$SCRIPTS_DIR/settlement.plutus"
ORDER_SCRIPT="$SCRIPTS_DIR/order.plutus"
POOL_SCRIPT="$SCRIPTS_DIR/pool.plutus"

cli() { cardano-cli latest "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }
txid() {
  cli transaction txid --tx-file "$1" \
    | python3 -c "import sys,json;s=sys.stdin.read().strip();print(json.loads(s)['txhash'] if s.startswith('{') else s)"
}

# ── Guards ─────────────────────────────────────────────────────────────────────────
[ "${MAINNET_CONFIRM:-}" = "I_UNDERSTAND_THIS_IS_IRREVERSIBLE" ] \
  || die "set MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE to proceed (immutable deploy)."
command -v cardano-cli >/dev/null || die "cardano-cli not found on PATH."
command -v aiken >/dev/null || die "aiken not found on PATH (needed for the reproducibility check)."
[ -n "${CARDANO_NODE_SOCKET_PATH:-}" ] && [ -S "$CARDANO_NODE_SOCKET_PATH" ] \
  || die "CARDANO_NODE_SOCKET_PATH must point at a running node socket."
: "${DEPLOY_SKEY:?set DEPLOY_SKEY to the funded mainnet signing key}"
: "${DEPLOY_ADDR:?set DEPLOY_ADDR to the funded mainnet address}"
[ -f "$DEPLOY_SKEY" ] || die "DEPLOY_SKEY file not found: $DEPLOY_SKEY"
case "$DEPLOY_ADDR" in addr1*) : ;; *) die "DEPLOY_ADDR is not a mainnet (addr1…) address: $DEPLOY_ADDR";; esac

# Confirm the node is actually on mainnet (networkId 1 / magic 764824073).
NET_MAGIC=$(cli query protocol-parameters --mainnet >/dev/null 2>&1 && echo ok || echo fail)
[ "$NET_MAGIC" = ok ] || die "node did not answer a --mainnet query; is this a mainnet node?"

# ── Step 0: the build is reproducible and the bytecode is the audited bytecode ───────
echo "==> [0/4] verifying reproducible build + script hashes"
( cd "$CONTRACTS" && aiken build >/dev/null && git diff --exit-code plutus.json >/dev/null ) \
  || die "plutus.json is not reproducible from source — refusing to deploy drifted artifacts."
verify_hash() { # <file> <expected-hash> <label>
  local got; got=$(cli transaction policyid --script-file "$1") \
    || die "could not hash $3 script ($1)"
  [ "$got" = "$2" ] || die "$3 hash mismatch: deployed $got != audited $2 (wrong/edited bytecode)."
  echo "    ok  $3 = $2"
}
verify_hash "$SETTLEMENT_SCRIPT" "$S_HASH" "settlement"
verify_hash "$ORDER_SCRIPT" "$ORDER_HASH" "order"
verify_hash "$POOL_SCRIPT" "$POOL_HASH" "pool"

# ── Plan + final confirmation ────────────────────────────────────────────────────────
cat <<PLAN

  ShaSwap MAINNET deployment plan
  ───────────────────────────────
  settlement (S / stake cred) : $S_HASH
  order validator             : $ORDER_HASH
  pool validator              : $POOL_HASH
  funding wallet              : $DEPLOY_ADDR
  will: (1) register S (Conway script-witnessed cert; publish handler authorizes registration only)
        (2) publish settlement/pool/order as reference scripts (one tx: #0/#1/#2)
        (3) verify all of the above on-chain
PLAN
read -r -p "  Type 'deploy' to proceed: " ANS; [ "$ANS" = deploy ] || die "aborted by operator."

# ── Step 1: register the settlement stake credential S ───────────────────────────────
echo "==> [1/4] registering settlement stake credential S"
cli query protocol-parameters --mainnet --out-file "$WORK/pparams.json"
DEP=$(python3 -c "import json;print(json.load(open('$WORK/pparams.json'))['stakeAddressDeposit'])")
echo '{"constructor":0,"fields":[]}' > "$WORK/unit.json"
cli stake-address registration-certificate \
  --stake-script-file "$SETTLEMENT_SCRIPT" --key-reg-deposit-amt "$DEP" \
  --out-file "$WORK/s.reg.cert"
UTXOS=$(cli query utxo --address "$DEPLOY_ADDR" --mainnet --output-json)
COLL=$(echo "$UTXOS" | python3 -c "import sys,json;u=json.load(sys.stdin);print(next(k for k,v in u.items() if list(v['value'])==['lovelace'] and v['value']['lovelace']<=10000000))")
TXIN=$(echo "$UTXOS" | python3 -c "import sys,json;u=json.load(sys.stdin);print(max(u,key=lambda k:u[k]['value'].get('lovelace',0)))")
cli transaction build --tx-in "$TXIN" --tx-in-collateral "$COLL" --change-address "$DEPLOY_ADDR" \
  --certificate-file "$WORK/s.reg.cert" --certificate-script-file "$SETTLEMENT_SCRIPT" \
  --certificate-redeemer-file "$WORK/unit.json" --mainnet --out-file "$WORK/s.reg.tx"
cli transaction sign --tx-file "$WORK/s.reg.tx" --signing-key-file "$DEPLOY_SKEY" \
  --mainnet --out-file "$WORK/s.reg.signed"
cli transaction submit --tx-file "$WORK/s.reg.signed" --mainnet
echo "    S registration submitted: $(txid "$WORK/s.reg.signed")"
echo "    waiting for confirmation before publishing refs (re-run if it times out)…"

# ── Step 2: publish reference scripts (settlement #0, pool #1, order #2) ──────────────
echo "==> [2/4] publishing reference scripts"
IN=$(cli query utxo --address "$DEPLOY_ADDR" --mainnet --output-json \
  | python3 -c "import sys,json;u=json.load(sys.stdin);print(max(u,key=lambda k:u[k]['value'].get('lovelace',0)))")
cli transaction build --tx-in "$IN" \
  --tx-out "$DEPLOY_ADDR+60000000" --tx-out-reference-script-file "$SETTLEMENT_SCRIPT" \
  --tx-out "$DEPLOY_ADDR+30000000" --tx-out-reference-script-file "$POOL_SCRIPT" \
  --tx-out "$DEPLOY_ADDR+15000000" --tx-out-reference-script-file "$ORDER_SCRIPT" \
  --change-address "$DEPLOY_ADDR" --mainnet --out-file "$WORK/refs.tx"
cli transaction sign --tx-file "$WORK/refs.tx" --signing-key-file "$DEPLOY_SKEY" \
  --mainnet --out-file "$WORK/refs.signed"
REFS_TXID=$(txid "$WORK/refs.signed")
cli transaction submit --tx-file "$WORK/refs.signed" --mainnet
python3 - "$REFS_TXID" > "$WORK/refs.json" <<'PY'
import sys, json
t = sys.argv[1]
json.dump({"settlement_ref": {"tx_id": t, "index": 0},
           "pool_ref":       {"tx_id": t, "index": 1},
           "order_ref":      {"tx_id": t, "index": 2}}, sys.stdout, indent=2)
PY
echo "    reference scripts submitted in tx $REFS_TXID  (settlement=#0, pool=#1, order=#2)"
echo "    refs written to $WORK/refs.json"

# ── Step 3: verify on-chain ──────────────────────────────────────────────────────────
echo "==> [3/4] verifying on-chain (allow a few blocks for confirmation, then re-run if empty)"
for pair in "$REFS_TXID#0:$S_HASH:settlement" "$REFS_TXID#1:$POOL_HASH:pool" "$REFS_TXID#2:$ORDER_HASH:order"; do
  ref="${pair%%:*}"; rest="${pair#*:}"; want="${rest%%:*}"; label="${rest#*:}"
  got=$(cli query utxo --tx-in "$ref" --mainnet --output-json \
    | python3 -c "import sys,json;u=json.load(sys.stdin);v=next(iter(u.values()),{});print(v.get('referenceScript',{}).get('script',{}).get('hash',''))" 2>/dev/null || true)
  if [ "$got" = "$want" ]; then echo "    ok  $label ref $ref carries $want";
  else echo "    !!  $label ref $ref hash='$got' (expected $want) — not yet confirmed? re-run step 3."; fi
done

# ── Step 4: next steps ───────────────────────────────────────────────────────────────
cat <<NEXT

==> [4/4] done. Wire the clients to these refs (deploy tx $REFS_TXID):
    - app/src/lib/chain/deployment.ts  → mainnet: orderRef={tx:$REFS_TXID,#2}, poolRef={tx:$REFS_TXID,#1}, deployed:true
    - .do/app.mainnet.yaml             → NEXT_PUBLIC_NETWORK=mainnet (+ mainnet Blockfrost key in DO console)
    - batcher deployment.mainnet.json  → settlement_ref #0 / pool_ref #1 / order_ref #2 = $REFS_TXID
    Then bootstrap liquidity + the verified-pool list, and run >=2 batchers.
    Full gate: documentation/launch/mainnet-checklist.md
NEXT
