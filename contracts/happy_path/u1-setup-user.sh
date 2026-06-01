#!/usr/bin/env bash
# Set up a separate USER (trader) wallet, distinct from the solver/batcher, so
# tests reflect production: the user posts orders (and pays only their own
# order-creation fee); the solver settles (and pays the settlement fee, earns the
# tips). Generates the key if missing (stored OUTSIDE the repo, next to solver.skey)
# and funds it from the solver with ADA + TEST.
#
# Usage: u1-setup-user.sh [fund_ada_lovelace] [fund_test]
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

FUND_ADA=${1:-200000000}     # 200 ADA
FUND_TEST=${2:-1000000000}   # 1e9 TEST
TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"

# 1) generate the user key if it doesn't exist yet.
if [ ! -f "$USER_SKEY" ]; then
  echo "generating user key at $USER_SKEY"
  cardano-cli latest address key-gen \
    --verification-key-file "$USER_VKEY" --signing-key-file "$USER_SKEY"
  cardano-cli latest address build \
    --payment-verification-key-file "$USER_VKEY" --testnet-magic "$NET_MAGIC" \
    --out-file "$KEYS_DIR/user.addr"
fi
USER_ADDR="$(cat "$KEYS_DIR/user.addr")"
echo "user address: $USER_ADDR"

# 2) already funded? (idempotent)
HAVE=$(cli query utxo --address "$USER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
if [ "$HAVE" != "0" ]; then
  echo "user already funded ($HAVE utxos); skipping."
  exit 0
fi

# 3) fund from the solver (pick its TEST-bearing UTXO as input).
IN=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | TEST_POLICY="$TEST_POLICY" python3 -c "
import sys,json,os;u=json.load(sys.stdin);tp=os.environ['TEST_POLICY']
c=[(k,v) for k,v in u.items() if any(p==tp for p in v['value'])]
c.sort(key=lambda kv:kv[1]['value'][tp]['54455354'],reverse=True);print(c[0][0])")
echo "funding from solver utxo $IN"

cli transaction build \
  --tx-in "$IN" \
  --tx-out "$USER_ADDR+$FUND_ADA+$FUND_TEST $TEST_POLICY.$TEST_NAME_HEX" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/fund-user.tx"
cli transaction sign --tx-file "$WORK/fund-user.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/fund-user.signed"
cli transaction submit --tx-file "$WORK/fund-user.signed" --testnet-magic "$NET_MAGIC"
echo "funded user with $FUND_ADA lovelace + $FUND_TEST TEST in tx $(txid "$WORK/fund-user.signed")"
