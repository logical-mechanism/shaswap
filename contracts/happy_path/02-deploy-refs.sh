#!/usr/bin/env bash
# Deploy the four validators as on-chain REFERENCE SCRIPTS (one UTXO each), so the
# settlement / reclaim / LP-intent txs can reference them instead of inlining ~20 KB of
# script. They are locked at the solver address (recoverable). Records their UTXO refs in
# work/refs.json for the batcher + app config. lp_intent (#3, Rev 22) is the fifth, additive
# immutable hash — the dApp spends it on the ReclaimLp path via this reference script.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

# Generous lovelace per ref UTXO (build enforces the true min-UTXO; extra just sits
# in the ref output): settlement ~9 KB, pool ~4.5 KB, order ~1 KB, lp_intent ~2.8 KB.
IN=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "import sys,json;u=json.load(sys.stdin);print(max(u,key=lambda k:u[k]['value'].get('lovelace',0)))")
echo "input=$IN"

cli transaction build \
  --tx-in "$IN" \
  --tx-out "$SOLVER_ADDR+60000000" --tx-out-reference-script-file "$SETTLEMENT_SCRIPT" \
  --tx-out "$SOLVER_ADDR+30000000" --tx-out-reference-script-file "$POOL_SCRIPT" \
  --tx-out "$SOLVER_ADDR+15000000" --tx-out-reference-script-file "$ORDER_SCRIPT" \
  --tx-out "$SOLVER_ADDR+25000000" --tx-out-reference-script-file "$LP_INTENT_SCRIPT" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/refs.tx"

cli transaction sign --tx-file "$WORK/refs.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/refs.signed"
TXID=$(txid "$WORK/refs.signed")
cli transaction submit --tx-file "$WORK/refs.signed" --testnet-magic "$NET_MAGIC"
echo "deployed refs in tx $TXID  (settlement=#0, pool=#1, order=#2, lp_intent=#3)"

python3 - "$TXID" > "$WORK/refs.json" <<'PY'
import sys, json
txid = sys.argv[1]
json.dump({"settlement_ref": {"tx_id": txid, "index": 0},
           "pool_ref":       {"tx_id": txid, "index": 1},
           "order_ref":      {"tx_id": txid, "index": 2},
           "lp_intent_ref":  {"tx_id": txid, "index": 3}},
          sys.stdout, indent=2)
PY
echo; echo "wrote $WORK/refs.json"
