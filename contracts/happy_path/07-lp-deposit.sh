#!/usr/bin/env bash
# LP deposit on the standalone `LpAction` path (BLUEPRINT §6) — the cardano-cli ground
# truth that cross-checks the app's `lp.ts` share math. Spends the pool UTXO via the
# pool reference script with redeemer LpAction (Constr 1 []), recreates the pool (same
# address, same inline PoolDatum, 1 NFT, no ref script) with reserves +Δ and the held
# LP lowered by the minted shares, and routes the minted LP to the solver as change.
#
# Doubles as the BOOTSTRAP: when the pool has no circulating LP yet (held == total_lp ⇒
# circ_in == 0) it takes the first-deposit branch — circ_out = floor(sqrt(res_a·res_b))
# and exactly MIN_LIQ LP is permanently locked at the unspendable mint-policy address
# Script(pool_policy) — moving the pool to circ > 0 so withdraw (08) is testable.
#
# Usage: 07-lp-deposit.sh [add_test] [add_ada_lovelace]
#   add_test          extra TEST (asset_a) to add on top of current reserves (default 0)
#   add_ada_lovelace  extra ADA reserve (asset_b) to add (default 0)
# Δ=0 on a circ_in==0 pool = "activate" the already-seeded reserves (mint LP against
# them). A subsequent deposit (circ_in>0) auto-pairs add_ada = ceil(add_test·res_b/res_a).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

ADD_A=${1:-0}     # TEST to add (asset_a)
ADD_B=${2:-0}     # ADA lovelace to add (asset_b); auto-paired on a subsequent deposit

POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")
TEST_POLICY=$(cat "$WORK/test-policy.id")
POOL_REF=$(python3 -c "import json;r=json.load(open('$WORK/refs.json'));print(r['pool_ref']['tx_id']+'#'+str(r['pool_ref']['index']))")

# the unspendable mint-policy address Script(pool_policy) — the first-deposit MIN_LIQ lock.
LOCK_ADDR=$(cli address build --payment-script-file "$WORK/pool_mint.plutus" --testnet-magic "$NET_MAGIC")
echo "lock address Script(pool_policy) = $LOCK_ADDR"

POOL_JSON=$(cli query utxo --address "$POOL_ADDR"   --testnet-magic "$NET_MAGIC" --output-json)
SOLVER_JSON=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)

# LpAction redeemer (Constr 1 []).
echo '{"constructor":1,"fields":[]}' > "$WORK/lpaction.json"

eval "$(POOL_POLICY="$POOL_POLICY" TEST_POLICY="$TEST_POLICY" \
  POOL_JSON="$POOL_JSON" SOLVER_JSON="$SOLVER_JSON" \
  POOL_MIN_ADA="$POOL_MIN_ADA" TOTAL_LP="$TOTAL_LP" MIN_LIQ="$MIN_LIQ" \
  ADD_A="$ADD_A" ADD_B="$ADD_B" python3 - <<'PY'
import os, json, math
pp=os.environ['POOL_POLICY']; tp=os.environ['TEST_POLICY']
NFT="4e4654"; LP="4c50"; TNAME="54455354"
pool_min=int(os.environ['POOL_MIN_ADA']); total_lp=int(os.environ['TOTAL_LP']); min_liq=int(os.environ['MIN_LIQ'])
add_a=int(os.environ['ADD_A']); add_b=int(os.environ['ADD_B'])
pool=json.loads(os.environ['POOL_JSON']); solver=json.loads(os.environ['SOLVER_JSON'])

# the genuine pool UTXO holds exactly 1 of its NFT.
def nft_qty(v): return v['value'].get(pp,{}).get(NFT,0)
(p_ref,p)=next((k,v) for k,v in pool.items() if nft_qty(v)==1)

res_a=p['value'][tp][TNAME]            # TEST reserve (asset_a)
pool_lovelace=p['value']['lovelace']
res_b=pool_lovelace-pool_min           # ADA reserve (asset_b)
held=p['value'][pp][LP]
circ_in=total_lp-held

if circ_in==0:
    # first deposit: shares = floor(sqrt(res_a_out · res_b_out)); lock MIN_LIQ.
    res_a_out=res_a+add_a; res_b_out=res_b+add_b
    assert res_a_out>0 and res_b_out>0, "first deposit: reserves must be positive"
    circ_out=math.isqrt(res_a_out*res_b_out)
    assert circ_out>min_liq, "first deposit too small (circ_out <= min_liq)"
    lock_lp=min_liq
    lp_to_user=circ_out-min_liq
else:
    # subsequent deposit: auto-pair add_b from add_a, mint the min (floored) side.
    assert add_a>0, "subsequent deposit needs add_test > 0"
    add_b=-(-add_a*res_b//res_a)       # ceil(add_a·res_b/res_a)
    res_a_out=res_a+add_a; res_b_out=res_b+add_b
    lp_to_user=min(add_a*circ_in//res_a, add_b*circ_in//res_b)
    assert lp_to_user>0, "deposit rounds to zero LP"
    circ_out=circ_in+lp_to_user
    lock_lp=0

held_out=total_lp-circ_out
pool_out_lovelace=res_b_out+pool_min

# inputs: a TEST source (only if adding asset_a), max pure-ADA fund, distinct collateral.
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
def hastest(v): return tp in v['value']
pures=sorted([k for k,v in solver.items() if pure(v)], key=lambda k:solver[k]['value']['lovelace'])
fund=pures[-1]; coll=pures[0]
test_in=next((k for k,v in solver.items() if hastest(v)), "") if add_a>0 else ""

pool_value=f"{pool_out_lovelace}+{res_a_out} {tp}.{TNAME}+1 {pp}.{NFT}+{held_out} {pp}.{LP}"
print(f"POOL_UTXO={p_ref}")
print(f"FUND={fund}")
print(f"COLL={coll}")
print(f"TEST_IN={test_in}")
print(f"POOL_VALUE='{pool_value}'")
print(f"LOCK_LP={lock_lp}")
print(f"FIRST={'1' if circ_in==0 else '0'}")
print(f"# circ_in={circ_in} circ_out={circ_out} lp_to_user={lp_to_user} add_a={add_a} add_b={add_b} held_out={held_out}")
PY
)"
echo "POOL=$POOL_UTXO FUND=$FUND COLL=$COLL TEST_IN=$TEST_IN FIRST=$FIRST LOCK_LP=$LOCK_LP"
echo "POOL_VALUE=$POOL_VALUE"

# optional lock output (first deposit only): MIN_LIQ LP at Script(pool_policy).
LOCK_OUT=()
if [ "$FIRST" = "1" ]; then
  LOCK_OUT=(--tx-out "${LOCK_ADDR}+${POOL_MIN_ADA}+${LOCK_LP} ${POOL_POLICY}.${LP_NAME}")
fi
# optional TEST funding input (adding asset_a reserves).
TEST_IN_ARG=()
[ -n "$TEST_IN" ] && TEST_IN_ARG=(--tx-in "$TEST_IN")

cli transaction build \
  --tx-in "$POOL_UTXO" \
    --spending-tx-in-reference "$POOL_REF" \
    --spending-plutus-script-v3 \
    --spending-reference-tx-in-inline-datum-present \
    --spending-reference-tx-in-redeemer-file "$WORK/lpaction.json" \
  "${TEST_IN_ARG[@]}" \
  --tx-in "$FUND" \
  --tx-in-collateral "$COLL" \
  --tx-out "${POOL_ADDR}+${POOL_VALUE}" \
    --tx-out-inline-datum-file "$WORK/pool.datum.json" \
  "${LOCK_OUT[@]}" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/lp-deposit.tx"

cli transaction sign --tx-file "$WORK/lp-deposit.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/lp-deposit.signed"
TXID=$(txid "$WORK/lp-deposit.signed")
echo "submitting LP deposit $TXID"
cli transaction submit --tx-file "$WORK/lp-deposit.signed" --testnet-magic "$NET_MAGIC"
echo "DEPOSITED in tx $TXID (first=$FIRST)"
