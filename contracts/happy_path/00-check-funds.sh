#!/usr/bin/env bash
# Show the solver wallet UTXOs + total balance, and the key protocol params we need.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

echo "solver address: $SOLVER_ADDR"
echo
cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC"
echo
TOTAL=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "import sys,json;u=json.load(sys.stdin);print(sum(o['value']['lovelace'] for o in u.values()))")
echo "total lovelace: ${TOTAL:-0}  (= $(python3 -c "print(${TOTAL:-0}/1_000_000)") tADA)"
