#!/usr/bin/env bash
# Post an ADA-seller order: sell ADA (asset_b) for TEST (asset_a), tagged S — the
# OPPOSING side to 05's token-seller, so the two can NET against each other in one
# settlement (pool moves only by the residual). A plain payment to the order script
# address with an inline OrderDatum (sell_a = False); no script runs at creation.
#
# The order UTXO holds the ADA being sold + the order min-ADA + the tip (asset_b is
# ADA, so all three roles are lovelace — the ADA triple-role accounting).
#
# Usage: 05b-post-ada-order.sh [sell_ada] [limit_test] [tip]
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

SELL=${1:-50000000}       # ADA (lovelace) to sell
LIMIT=${2:-90000000}      # min TEST to receive (the per-order floor)
TIP=${3:-2000000}         # solver tip
ORDER_ADA=$((SELL + ORDER_MIN_ADA + TIP))

POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")

cat > "$WORK/order.ada.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]},
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":0,"fields":[]},
  {"int":$SELL},
  {"int":$LIMIT},
  {"int":$TIP},
  {"constructor":0,"fields":[]},
  {"constructor":1,"fields":[]}
]}
JSON

# Pick the solver UTXO with the most ADA to fund the order (excludes ref scripts:
# those carry a referenceScript and are skipped).
IN=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "
import sys,json; u=json.load(sys.stdin)
cands=[(k,v) for k,v in u.items() if not v.get('referenceScript')]
cands.sort(key=lambda kv: kv[1]['value']['lovelace'], reverse=True)
print(cands[0][0])")
echo "funding input (most ADA) = $IN"

cli transaction build \
  --tx-in "$IN" \
  --tx-out "$ORDER_ADDR+$ORDER_ADA" \
  --tx-out-inline-datum-file "$WORK/order.ada.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/order.ada.tx"

cli transaction sign --tx-file "$WORK/order.ada.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/order.ada.signed"
TXID=$(txid "$WORK/order.ada.signed")
cli transaction submit --tx-file "$WORK/order.ada.signed" --testnet-magic "$NET_MAGIC"
echo "posted ADA-seller order (sell $SELL ADA, floor $LIMIT TEST, tip $TIP) in tx $TXID#0"
