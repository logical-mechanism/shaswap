#!/usr/bin/env bash
# Mint a test token (TEST) under a simple signature native-script policy, so we have
# a non-ADA asset to pair the pool with. Sends the supply to the solver wallet.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

TEST_NAME_HEX="54455354"   # "TEST"
SUPPLY=10000000000

# native policy: "must be signed by the solver key"
cat > "$WORK/test-policy.json" <<JSON
{ "type": "sig", "keyHash": "$SOLVER_PKH" }
JSON
TEST_POLICY=$(cli transaction policyid --script-file "$WORK/test-policy.json")
echo "TEST policy = $TEST_POLICY"
echo "$TEST_POLICY" > "$WORK/test-policy.id"

IN=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "import sys,json;u=json.load(sys.stdin);print(max(u,key=lambda k:u[k]['value'].get('lovelace',0)))")

cli transaction build \
  --tx-in "$IN" \
  --mint "$SUPPLY $TEST_POLICY.$TEST_NAME_HEX" \
  --mint-script-file "$WORK/test-policy.json" \
  --tx-out "$SOLVER_ADDR+5000000+$SUPPLY $TEST_POLICY.$TEST_NAME_HEX" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/mint.tx"

cli transaction sign --tx-file "$WORK/mint.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/mint.signed"
TXID=$(txid "$WORK/mint.signed")
cli transaction submit --tx-file "$WORK/mint.signed" --testnet-magic "$NET_MAGIC"
echo "minted $SUPPLY TEST ($TEST_POLICY) in tx $TXID"
