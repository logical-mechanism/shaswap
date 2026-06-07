#!/usr/bin/env bash
# Post a batcher-fulfilled LP-intent UTXO at the lp_intent ENTERPRISE address (BLUEPRINT
# §5.1 Rev 22). Default: a DEPOSIT intent (needs no prior LP). The permissionless batcher
# discovers it (kupo indexes the lp_intent address) and fulfils it like an order, depositing
# into the pool + paying the minted LP to the owner, keeping only the tip.
#
#   DA=<TEST units> DB=<ADA lovelace> TIP=<lovelace> bash 10-post-lp-intent.sh
#
# Owner = the solver vkey (None stake → enterprise payout back to SOLVER_ADDR), so the test
# is self-contained. The intent value: DA TEST + (DB + TIP + lp_intent_min_ada) lovelace.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

: "${DA:=100000000}"      # 100 TEST to deposit (asset_a)
: "${DB:=100000000}"      # 100 ADA to deposit (asset_b), lovelace
: "${TIP:=1500000}"       # 1.5 ADA solver tip
LP_INTENT_MIN_ADA=2000000

POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")
NFT_UNIT="$POOL_POLICY.$NFT_NAME"
TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"

# Read the live pool (reserves + held LP) to compute a conservative min_shares floor.
POOL_UTXO_JSON=$(cli query utxo --address "$POOL_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
read RES_A RES_B CIRC < <(echo "$POOL_UTXO_JSON" | POL="$POOL_POLICY" TP="$TEST_POLICY" python3 -c "
import sys,json,os
u=json.load(sys.stdin); pol=os.environ['POL']; tp=os.environ['TP']
nft=pol+'.4e4654'; lp=pol+'.4c50'
TOTAL_LP=9223372036854775807; POOL_MIN_ADA=2000000
def q(v,unit):
    if unit=='lovelace': return v['value'].get('lovelace',0)
    p,n=unit.split('.'); return v['value'].get(p,{}).get(n,0)
pu=next(v for v in u.values() if q(v,nft)==1)
res_a=q(pu, tp+'.54455354')              # TEST reserve (asset_a)
res_b=q(pu,'lovelace')-POOL_MIN_ADA      # ADA reserve (asset_b)
held=q(pu, lp); circ=TOTAL_LP-held
print(res_a, res_b, circ)
")
echo "pool reserves: $RES_A TEST / $RES_B ADA(lovelace)  circ=$CIRC"
# fair shares = min(floor(DA*circ/res_a), floor(DB*circ/res_b)); floor 1% for the on-chain min_shares.
MIN_SHARES=$(python3 -c "
da=$DA; db=$DB; ra=$RES_A; rb=$RES_B; circ=$CIRC
fair=min(da*circ//ra, db*circ//rb)
print(max(1, fair*99//100))
")
echo "deposit $DA TEST + $DB ADA  tip $TIP  -> min_shares floor $MIN_SHARES"

# LpIntentDatum = Constr 0 [owner(VK), owner_stake(None), pool_nft, LpDeposit, 0,0,min_shares, tip, None]
cat > "$WORK/lp_intent.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]},
  {"constructor":1,"fields":[]},
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":0,"fields":[]},
  {"int":0},{"int":0},{"int":$MIN_SHARES},
  {"int":$TIP},
  {"constructor":1,"fields":[]}
]}
JSON

LOVELACE=$((DB + TIP + LP_INTENT_MIN_ADA))
INTENT_VALUE="$LOVELACE+$DA $TEST_POLICY.$TEST_NAME_HEX"
echo "intent value: $INTENT_VALUE  -> $LP_INTENT_ADDR"

IN=$(echo "$POOL_UTXO_JSON" >/dev/null; cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | TP="$TEST_POLICY" DA="$DA" python3 -c "
import sys,json,os
u=json.load(sys.stdin); tp=os.environ['TP']; da=int(os.environ['DA'])
# pick a UTXO holding enough TEST + ada; else let the builder coin-select via multiple --tx-in
cands=[k for k,v in u.items() if v['value'].get(tp,{}).get('54455354',0)>=da and v['value'].get('lovelace',0)>5_000_000]
print(cands[0] if cands else max(u,key=lambda k:u[k]['value'].get('lovelace',0)))
")
# also add a pure funding input for fees/min-ada
FUND=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | python3 -c "import sys,json;u=json.load(sys.stdin);ada=sorted((k for k,v in u.items() if list(v['value'])==['lovelace']),key=lambda k:-u[k]['value']['lovelace']);print(ada[0] if ada else '')")
echo "inputs: $IN  $FUND"

cli transaction build \
  --tx-in "$IN" \
  ${FUND:+--tx-in "$FUND"} \
  --tx-out "$LP_INTENT_ADDR+$INTENT_VALUE" \
  --tx-out-inline-datum-file "$WORK/lp_intent.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/lp_intent.tx"

cli transaction sign --tx-file "$WORK/lp_intent.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/lp_intent.signed"
ITXID=$(txid "$WORK/lp_intent.signed")
cli transaction submit --tx-file "$WORK/lp_intent.signed" --testnet-magic "$NET_MAGIC"
echo "posted LP-deposit intent in tx $ITXID -> $LP_INTENT_ADDR#0"
echo "$ITXID" > "$WORK/lp_intent.txid"