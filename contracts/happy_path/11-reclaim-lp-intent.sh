#!/usr/bin/env bash
# Owner-reclaim an LP intent (the ReclaimLp path, BLUEPRINT §5.1 Rev 22). Spends the intent
# UTXO with the ReclaimLp redeemer via the lp_intent REFERENCE script (no inlined validator),
# authorised by the owner's signature. The full intent value returns to the owner. A withdraw
# reclaim returns the LP tokens, NOT the underlying (§13 residual); a deposit reclaim returns
# the A+B it locked. Pass the intent UTXO ref, or it reads work/lp_intent.txid (#0).
#
#   REF=<txid#ix> bash 11-reclaim-lp-intent.sh
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

REF="${REF:-$(cat "$WORK/lp_intent.txid")#0}"
echo "reclaiming intent $REF"

LP_INTENT_REF_TXID="c5751d0d3f0e69acec31550753c67f379db9e12b6ff510b5d5034f271dea866f"
LP_INTENT_REF_IX=3

echo '{"constructor":1,"fields":[]}' > "$WORK/reclaim.redeemer.json"   # LpIntentRedeemer::ReclaimLp

# Collateral: a small pure-ada UTXO at the solver (the reclaim runs a Plutus script).
COLL=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "import sys,json;u=json.load(sys.stdin);print(next(k for k,v in u.items() if list(v['value'])==['lovelace'] and v['value']['lovelace']<=10000000))")
echo "collateral=$COLL  owner=$SOLVER_PKH"

cli transaction build \
  --tx-in "$REF" \
  --spending-tx-in-reference "$LP_INTENT_REF_TXID#$LP_INTENT_REF_IX" \
  --spending-plutus-script-v3 \
  --spending-reference-tx-in-inline-datum-present \
  --spending-reference-tx-in-redeemer-file "$WORK/reclaim.redeemer.json" \
  --tx-in-collateral "$COLL" \
  --required-signer-hash "$SOLVER_PKH" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/reclaim.tx"

cli transaction sign --tx-file "$WORK/reclaim.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/reclaim.signed"
RT=$(txid "$WORK/reclaim.signed")
cli transaction submit --tx-file "$WORK/reclaim.signed" --testnet-magic "$NET_MAGIC"
echo "reclaimed intent in tx $RT (value back to $SOLVER_ADDR)"
echo "$RT" > "$WORK/reclaim.txid"
