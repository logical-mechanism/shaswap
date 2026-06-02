#!/usr/bin/env bash
# Post a test order: sell TEST (asset_a) for ADA, tagged S. A plain payment to the
# order script address with an inline OrderDatum — no script runs at creation.
# Usage: 05-post-order.sh [sell_amount] [limit_ada] [tip]
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

SELL=${1:-100000000}      # TEST to sell
LIMIT=${2:-50000000}      # min ADA to receive (the per-order floor)
TIP=${3:-2000000}         # solver tip
ORDER_ADA=$((ORDER_MIN_ADA + TIP))

POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")
TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"

# owner_stake = Some(VerificationKey(SOLVER_STAKE_PKH)) -> base-address payout (Rev 21).
cat > "$WORK/order.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]},
  {"constructor":0,"fields":[{"constructor":0,"fields":[{"bytes":"$SOLVER_STAKE_PKH"}]}]},
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":1,"fields":[]},
  {"int":$SELL},
  {"int":$LIMIT},
  {"int":$TIP},
  {"constructor":0,"fields":[]},
  {"constructor":1,"fields":[]}
]}
JSON

IN=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | TEST_POLICY="$TEST_POLICY" python3 -c "
import sys,json,os; u=json.load(sys.stdin); tp=os.environ['TEST_POLICY']
# need an input with enough TEST and ADA; pick the one holding the most TEST.
cands=[(k,v) for k,v in u.items() if any(p==tp for p in v['value'])]
cands.sort(key=lambda kv: kv[1]['value'][tp]['54455354'], reverse=True)
print(cands[0][0])")
echo "funding input (holds TEST) = $IN"

cli transaction build \
  --tx-in "$IN" \
  --tx-out "$ORDER_ADDR+$ORDER_ADA+$SELL $TEST_POLICY.$TEST_NAME_HEX" \
  --tx-out-inline-datum-file "$WORK/order.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/order.tx"

cli transaction sign --tx-file "$WORK/order.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/order.signed"
TXID=$(txid "$WORK/order.signed")
cli transaction submit --tx-file "$WORK/order.signed" --testnet-magic "$NET_MAGIC"
echo "posted order (sell $SELL TEST, floor $LIMIT ADA, tip $TIP) in tx $TXID#0"
