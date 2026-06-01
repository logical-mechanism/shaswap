#!/usr/bin/env bash
# Build + submit a settlement for the single live token-seller order against the
# pool — the once-per-tx withdraw-0 anchor in action. The pins (price, received,
# owner/pool values) are computed the SAME way solver-core does (floor-only v1:
# one order, the pool absorbs the whole trade at its own execution price). This is
# the on-chain proof of the full design; the Rust batcher reproduces it programmatically.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")
TEST_POLICY=$(cat "$WORK/test-policy.id")
SETTLE_REF=$(python3 -c "import json;r=json.load(open('$WORK/refs.json'));print(r['settlement_ref']['tx_id']+'#'+str(r['settlement_ref']['index']))")
POOL_REF=$(python3   -c "import json;r=json.load(open('$WORK/refs.json'));print(r['pool_ref']['tx_id']+'#'+str(r['pool_ref']['index']))")
ORDER_REF=$(python3  -c "import json;r=json.load(open('$WORK/refs.json'));print(r['order_ref']['tx_id']+'#'+str(r['order_ref']['index']))")

ORDER_JSON=$(cli query utxo --address "$ORDER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
POOL_JSON=$(cli query utxo --address "$POOL_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
SOLVER_JSON=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)

eval "$(POOL_POLICY="$POOL_POLICY" TEST_POLICY="$TEST_POLICY" \
  ORDER_JSON="$ORDER_JSON" POOL_JSON="$POOL_JSON" SOLVER_JSON="$SOLVER_JSON" \
  POOL_MIN_ADA="$POOL_MIN_ADA" WORK="$WORK" python3 - <<'PY'
import os, json
pp=os.environ['POOL_POLICY']; tp=os.environ['TEST_POLICY']
NFT="4e4654"; LP="4c50"; TNAME="54455354"
pool_min=int(os.environ['POOL_MIN_ADA']); WORK=os.environ['WORK']
order=json.loads(os.environ['ORDER_JSON']); pool=json.loads(os.environ['POOL_JSON']); solver=json.loads(os.environ['SOLVER_JSON'])

(o_ref, o)=next(iter(order.items()))
(p_ref, p)=next(iter(pool.items()))
od=o['inlineDatum']['fields']
sell=int(od[3]['int']); limit=int(od[4]['int']); tip=int(od[5]['int'])
order_lovelace=o['value']['lovelace']

res_a=p['value'][tp][TNAME]                 # TEST reserve
pool_lovelace=p['value']['lovelace']
res_b=pool_lovelace-pool_min                # ADA reserve
held_lp=p['value'][pp][LP]
fee_num,fee_den=3,1000; g=fee_den-fee_num

# pool execution: max ADA out for `sell` TEST in (mirrors curve::swap_out, floored)
received=(res_b*sell*g)//(res_a*fee_den+sell*g)
num,den=received,sell                        # uniform price = received/sell
# floor at full fill must hold: sell*num >= limit*den
assert sell*num>=limit*den, "floor breach"

owner_lovelace=order_lovelace+received-tip   # in - tip + received (TEST fully sold)
pool_out_lovelace=pool_lovelace-received
pool_out_test=res_a+sell

o_txid,o_idx=o_ref.split('#')
# settle / poolsettle redeemers (Constr 0 [])
json.dump({"constructor":0,"fields":[]}, open(f"{WORK}/settle.json","w"))
json.dump({"constructor":0,"fields":[]}, open(f"{WORK}/poolsettle.json","w"))
# owner BoundDatum { order_ref }
json.dump({"constructor":0,"fields":[{"constructor":0,"fields":[{"bytes":o_txid},{"int":int(o_idx)}]}]},
          open(f"{WORK}/bound.datum.json","w"))
# SettlementRedeemer
aid=lambda pol,nm:{"constructor":0,"fields":[{"bytes":pol},{"bytes":nm}]}
json.dump({"constructor":0,"fields":[
    {"int":num},{"int":den}, aid(tp,TNAME), aid("",""), aid(pp,NFT),
    {"list":[{"int":sell}]}]}, open(f"{WORK}/settlement.redeemer.json","w"))

# funding (max pure-ADA, no refscript) + collateral (a small pure-ADA, distinct)
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
pures=sorted([k for k,v in solver.items() if pure(v)], key=lambda k:solver[k]['value']['lovelace'])
fund=pures[-1]; coll=pures[0]

pool_value=f"{pool_out_lovelace}+{pool_out_test} {tp}.{TNAME}+1 {pp}.{NFT}+{held_lp} {pp}.{LP}"
print(f"ORDER_UTXO={o_ref}")
print(f"POOL_UTXO={p_ref}")
print(f"FUND={fund}")
print(f"COLL={coll}")
print(f"OWNER_LOVELACE={owner_lovelace}")
print(f"POOL_VALUE='{pool_value}'")
print(f"# received={received} price={num}/{den} sell={sell} limit={limit} tip={tip}")
PY
)"
echo "ORDER=$ORDER_UTXO POOL=$POOL_UTXO FUND=$FUND COLL=$COLL OWNER_LOVELACE=$OWNER_LOVELACE"
echo "POOL_VALUE=$POOL_VALUE"

cli transaction build \
  --tx-in "$ORDER_UTXO" \
    --spending-tx-in-reference "$ORDER_REF" \
    --spending-plutus-script-v3 \
    --spending-reference-tx-in-inline-datum-present \
    --spending-reference-tx-in-redeemer-file "$WORK/settle.json" \
  --tx-in "$POOL_UTXO" \
    --spending-tx-in-reference "$POOL_REF" \
    --spending-plutus-script-v3 \
    --spending-reference-tx-in-inline-datum-present \
    --spending-reference-tx-in-redeemer-file "$WORK/poolsettle.json" \
  --tx-in "$FUND" \
  --tx-in-collateral "$COLL" \
  --withdrawal "${S_STAKE_ADDR}+0" \
    --withdrawal-tx-in-reference "$SETTLE_REF" \
    --withdrawal-plutus-script-v3 \
    --withdrawal-reference-tx-in-redeemer-file "$WORK/settlement.redeemer.json" \
  --tx-out "${SOLVER_ADDR}+${OWNER_LOVELACE}" \
    --tx-out-inline-datum-file "$WORK/bound.datum.json" \
  --tx-out "${POOL_ADDR}+${POOL_VALUE}" \
    --tx-out-inline-datum-file "$WORK/pool.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/settle.tx"

cli transaction sign --tx-file "$WORK/settle.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/settle.signed"
TXID=$(txid "$WORK/settle.signed")
echo "submitting settlement $TXID"
cli transaction submit --tx-file "$WORK/settle.signed" --testnet-magic "$NET_MAGIC"
echo "SETTLED in tx $TXID"
