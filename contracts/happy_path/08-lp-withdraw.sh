#!/usr/bin/env bash
# LP withdraw on the standalone `LpAction` path (BLUEPRINT §6) — the cardano-cli ground
# truth that cross-checks the app's `lp.ts` withdraw math. Spends the pool UTXO via the
# pool reference script with redeemer LpAction (Constr 1 []), recreates the pool with
# reserves −recv and the held LP RAISED by the burned shares, and returns a proportional
# (floored) share of both reserves to the solver as change. The solver funds the burned
# LP from its own wallet (the LP it received from 07). circ_out must stay ≥ MIN_LIQ.
#
# Usage: 08-lp-withdraw.sh [lp_to_burn]
#   lp_to_burn   circulating LP to burn (default: 10% of current circulating).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

BURN=${1:-0}

POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")
TEST_POLICY=$(cat "$WORK/test-policy.id")
POOL_REF=$(python3 -c "import json;r=json.load(open('$WORK/refs.json'));print(r['pool_ref']['tx_id']+'#'+str(r['pool_ref']['index']))")

POOL_JSON=$(cli query utxo --address "$POOL_ADDR"   --testnet-magic "$NET_MAGIC" --output-json)
SOLVER_JSON=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)

# LpAction redeemer (Constr 1 []).
echo '{"constructor":1,"fields":[]}' > "$WORK/lpaction.json"

# Capture + check exit before eval — `eval "$(...)"` alone hides a failed python
# guard (assert) from `set -e`, which would otherwise build a malformed tx.
OUT=$(POOL_POLICY="$POOL_POLICY" TEST_POLICY="$TEST_POLICY" \
  POOL_JSON="$POOL_JSON" SOLVER_JSON="$SOLVER_JSON" \
  POOL_MIN_ADA="$POOL_MIN_ADA" TOTAL_LP="$TOTAL_LP" MIN_LIQ="$MIN_LIQ" BURN="$BURN" python3 - <<'PY'
import os, json
pp=os.environ['POOL_POLICY']; tp=os.environ['TEST_POLICY']
NFT="4e4654"; LP="4c50"; TNAME="54455354"
pool_min=int(os.environ['POOL_MIN_ADA']); total_lp=int(os.environ['TOTAL_LP']); min_liq=int(os.environ['MIN_LIQ'])
burn=int(os.environ['BURN'])
pool=json.loads(os.environ['POOL_JSON']); solver=json.loads(os.environ['SOLVER_JSON'])

def nft_qty(v): return v['value'].get(pp,{}).get(NFT,0)
(p_ref,p)=next((k,v) for k,v in pool.items() if nft_qty(v)==1)

res_a=p['value'][tp][TNAME]            # TEST reserve (asset_a)
pool_lovelace=p['value']['lovelace']
res_b=pool_lovelace-pool_min           # ADA reserve (asset_b)
held=p['value'][pp][LP]
circ_in=total_lp-held
assert circ_in>0, "pool has no circulating LP — run 07 (bootstrap) first"

if burn==0: burn=circ_in//10           # default: withdraw 10%
assert burn>0, "nothing to burn"
circ_out=circ_in-burn
assert circ_out>=min_liq, f"withdraw would drop circulating below min_liq ({min_liq})"

recv_a=burn*res_a//circ_in             # floor
recv_b=burn*res_b//circ_in             # floor
assert recv_a>0 or recv_b>0, "withdraw rounds to zero on both sides"
res_a_out=res_a-recv_a; res_b_out=res_b-recv_b
held_out=total_lp-circ_out             # = held + burn
pool_out_lovelace=res_b_out+pool_min

# inputs: the solver's LP source (holds >= burn LP), a pure-ADA fund, distinct collateral.
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
def lp_qty(v): return v['value'].get(pp,{}).get(LP,0)
lp_in=next((k for k,v in solver.items() if lp_qty(v)>=burn), "")
assert lp_in, f"no wallet UTXO holds >= {burn} LP — split/fund the solver's LP first"
pures=sorted([k for k,v in solver.items() if pure(v)], key=lambda k:solver[k]['value']['lovelace'])
assert len(pures)>=2, "need >=2 pure-ADA UTXOs (one fund + one distinct collateral)"
fund=pures[-1]; coll=pures[0]

pool_value=f"{pool_out_lovelace}+{res_a_out} {tp}.{TNAME}+1 {pp}.{NFT}+{held_out} {pp}.{LP}"
print(f"POOL_UTXO={p_ref}")
print(f"LP_IN={lp_in}")
print(f"FUND={fund}")
print(f"COLL={coll}")
print(f"POOL_VALUE='{pool_value}'")
print(f"# circ_in={circ_in} burn={burn} circ_out={circ_out} recv_a={recv_a} recv_b={recv_b} held_out={held_out}")
PY
) || { echo "LP-withdraw share-math failed (see error above)" >&2; exit 1; }
eval "$OUT"
echo "POOL=$POOL_UTXO LP_IN=$LP_IN FUND=$FUND COLL=$COLL"
echo "POOL_VALUE=$POOL_VALUE"

cli transaction build \
  --tx-in "$POOL_UTXO" \
    --spending-tx-in-reference "$POOL_REF" \
    --spending-plutus-script-v3 \
    --spending-reference-tx-in-inline-datum-present \
    --spending-reference-tx-in-redeemer-file "$WORK/lpaction.json" \
  --tx-in "$LP_IN" \
  --tx-in "$FUND" \
  --tx-in-collateral "$COLL" \
  --tx-out "${POOL_ADDR}+${POOL_VALUE}" \
    --tx-out-inline-datum-file "$WORK/pool.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/lp-withdraw.tx"

cli transaction sign --tx-file "$WORK/lp-withdraw.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/lp-withdraw.signed"
TXID=$(txid "$WORK/lp-withdraw.signed")
echo "submitting LP withdraw $TXID"
cli transaction submit --tx-file "$WORK/lp-withdraw.signed" --testnet-magic "$NET_MAGIC"
echo "WITHDRAWN in tx $TXID"
