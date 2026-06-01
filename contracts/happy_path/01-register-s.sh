#!/usr/bin/env bash
# Register the settlement stake credential S (a SCRIPT stake credential). Required
# so the withdraw-0 trick is valid (you can only withdraw from a registered reward
# account). On Conway a script stake credential's own script must authorize the
# registration certificate, so we attach the settlement script as the cert witness;
# its `publish` handler permits registration (only). We register S and NEVER
# delegate it (the handler also forbids delegation/de-registration → immortal anchor).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

DEP=$(python3 -c "import json;print(json.load(open('$WORK/pparams.json'))['stakeAddressDeposit'])")
echo "stake deposit: $DEP"
echo '{"constructor":0,"fields":[]}' > "$WORK/unit.json"   # cert redeemer (ignored by the handler)

cli stake-address registration-certificate \
  --stake-script-file "$SETTLEMENT_SCRIPT" \
  --key-reg-deposit-amt "$DEP" \
  --out-file "$WORK/s.reg.cert"

# a pure-ADA UTXO for collateral (the cert is witnessed by a Plutus script) + inputs
UTXOS=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
COLL=$(echo "$UTXOS" | python3 -c "import sys,json;u=json.load(sys.stdin);print(next(k for k,v in u.items() if list(v['value'])==['lovelace'] and v['value']['lovelace']<=10000000))")
TXIN=$(echo "$UTXOS" | python3 -c "import sys,json;u=json.load(sys.stdin);print(max(u,key=lambda k:u[k]['value'].get('lovelace',0)))")
echo "input=$TXIN  collateral=$COLL"

cli transaction build \
  --tx-in "$TXIN" \
  --tx-in-collateral "$COLL" \
  --change-address "$SOLVER_ADDR" \
  --certificate-file "$WORK/s.reg.cert" \
  --certificate-script-file "$SETTLEMENT_SCRIPT" \
  --certificate-redeemer-file "$WORK/unit.json" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/s.reg.tx"

cli transaction sign --tx-file "$WORK/s.reg.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/s.reg.signed"

TXID=$(cli transaction txid --tx-file "$WORK/s.reg.signed")
echo "submitting S registration: $TXID"
cli transaction submit --tx-file "$WORK/s.reg.signed" --testnet-magic "$NET_MAGIC"
echo "submitted. txid=$TXID"
