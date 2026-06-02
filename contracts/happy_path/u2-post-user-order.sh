#!/usr/bin/env bash
# The USER posts a token-seller order (sell TEST for ADA), owned + funded + signed
# by the USER key (not the solver). The order's `owner` is the user's PKH, so the
# settlement's owner payout goes to the user's address — letting tests verify the
# user is floor-protected and pays NO settlement fee (the solver pays it, earns the
# tip). Targets pool1 by default (its NFT policy from work/pool.json).
#
# Usage: u2-post-user-order.sh [sell_test] [limit_ada] [tip] [pool_policy]
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

SELL=${1:-100000000}
LIMIT=${2:-45000000}
TIP=${3:-2000000}
POOL_POLICY=${4:-$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")}
ORDER_ADA=$((ORDER_MIN_ADA + TIP))
TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"

if [ -z "${USER_PKH:-}" ]; then echo "no user key — run u1-setup-user.sh first" >&2; exit 1; fi

# owner = USER's verification-key hash (settlement payout goes to the user). The user
# wallet is enterprise-only, so owner_stake = None (enterprise payout); the base-address
# payout is exercised by the solver order (05) + the app (Lace) instead.
cat > "$WORK/user-order.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$USER_PKH"}]},
  {"constructor":1,"fields":[]},
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":1,"fields":[]},
  {"int":$SELL},
  {"int":$LIMIT},
  {"int":$TIP},
  {"constructor":0,"fields":[]},
  {"constructor":1,"fields":[]}
]}
JSON

# fund from the USER's own wallet (their TEST-bearing UTXO); USER signs + pays.
IN=$(cli query utxo --address "$USER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | TEST_POLICY="$TEST_POLICY" python3 -c "
import sys,json,os;u=json.load(sys.stdin);tp=os.environ['TEST_POLICY']
c=[(k,v) for k,v in u.items() if any(p==tp for p in v['value'])]
c.sort(key=lambda kv:kv[1]['value'][tp]['54455354'],reverse=True);print(c[0][0])")
echo "user funding input = $IN"

cli transaction build \
  --tx-in "$IN" \
  --tx-out "$ORDER_ADDR+$ORDER_ADA+$SELL $TEST_POLICY.$TEST_NAME_HEX" \
  --tx-out-inline-datum-file "$WORK/user-order.datum.json" \
  --change-address "$USER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/user-order.tx"
cli transaction sign --tx-file "$WORK/user-order.tx" --signing-key-file "$USER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/user-order.signed"
TXID=$(txid "$WORK/user-order.signed")
cli transaction submit --tx-file "$WORK/user-order.signed" --testnet-magic "$NET_MAGIC"
echo "user posted order (sell $SELL TEST, floor $LIMIT ADA, tip $TIP) in tx $TXID#0"
