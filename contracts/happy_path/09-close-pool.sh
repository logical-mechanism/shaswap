#!/usr/bin/env bash
# Close a created-but-never-seeded pool (BLUEPRINT §5.1 path c) — the cardano-cli ground
# truth that cross-checks the app's `closePool` (spend pool `ClosePool` + burn NFT+LP).
#
# Self-contained, so it never disturbs the 04 pool that 07/08 use: it (1) mints a bare
# EMPTY pool (its own seed; NFT + total_lp LP + pool_min_ada, NO reserves) via
# pool_mint(seed) with Create, waits for it to confirm, then (2) CLOSES it — spends the
# pool UTXO via the pool reference script with ClosePool (Constr 2 []), burns
# {NFT:-1, LP:-total_lp} under the seed-applied policy with Close (Constr 1 []), and the
# solver (= creator) signs. The pool's ~2 ADA seed returns to the solver as change.
#
# Proves the spend+burn combo the app builds. Requires a running preprod node + the
# solver wallet (>=3 pure-ADA UTXOs). asset_a = TEST, asset_b = ADA (same as 04).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"
CW="$WORK/close"; mkdir -p "$CW"
POOL_REF=$(python3 -c "import json;r=json.load(open('$WORK/refs.json'));print(r['pool_ref']['tx_id']+'#'+str(r['pool_ref']['index']))")

# ---- 1. pick a seed + fund + collateral (3 distinct pure-ADA UTXOs) ----------
U=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
read SEED FUND COLL < <(echo "$U" | python3 -c "
import sys,json
u=json.load(sys.stdin)
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
pures=sorted([k for k,v in u.items() if pure(v)], key=lambda k:u[k]['value']['lovelace'])
assert len(pures)>=3, 'need >=3 pure-ADA UTXOs (seed + fund + collateral)'
print(pures[0], pures[-1], pures[1])   # seed=smallest, fund=largest, coll=2nd-smallest
")
echo "seed=$SEED  fund=$FUND  collateral=$COLL"

# ---- 2. instantiate pool_mint(seed) -> the one-shot policy --------------------
SEED_TX=${SEED%%#*}; SEED_IX=${SEED##*#}
IDX_CBOR=$(python3 -c "i=$SEED_IX; print(format(i,'02x') if i<24 else ('18'+format(i,'02x')))")
SEED_PARAM="d8799f5820${SEED_TX}${IDX_CBOR}ff"
aiken blueprint apply -i "$HP_DIR/../plutus.json" -m pool_mint -v pool_mint "$SEED_PARAM" -o "$CW/pool_mint.bp.json" >/dev/null 2>&1
mkdir -p "$CW/pmbp"; cp "$CW/pool_mint.bp.json" "$CW/pmbp/plutus.json"
aiken blueprint convert "$CW/pmbp" -m pool_mint -v pool_mint --to cardano-cli > "$CW/pool_mint.plutus"
POOL_POLICY=$(cli transaction policyid --script-file "$CW/pool_mint.plutus")
echo "empty-pool policy = $POOL_POLICY"

# ---- 3. CREATE the bare empty pool (no reserves) -----------------------------
cat > "$CW/pool.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":0,"fields":[{"bytes":"$TEST_POLICY"},{"bytes":"$TEST_NAME_HEX"}]},
  {"constructor":0,"fields":[{"bytes":""},{"bytes":""}]},
  {"int":3},{"int":1000},
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]}
]}
JSON
echo '{"constructor":0,"fields":[]}' > "$CW/create.json"   # MintRedeemer::Create

cli transaction build \
  --tx-in "$SEED" \
  --tx-in "$FUND" \
  --tx-in-collateral "$COLL" \
  --mint "1 $POOL_POLICY.$NFT_NAME+$TOTAL_LP $POOL_POLICY.$LP_NAME" \
    --mint-script-file "$CW/pool_mint.plutus" \
    --mint-redeemer-file "$CW/create.json" \
  --tx-out "$POOL_ADDR+$POOL_MIN_ADA+1 $POOL_POLICY.$NFT_NAME+$TOTAL_LP $POOL_POLICY.$LP_NAME" \
    --tx-out-inline-datum-file "$CW/pool.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$CW/create.tx"
cli transaction sign --tx-file "$CW/create.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$CW/create.signed"
CREATE_TXID=$(txid "$CW/create.signed")
cli transaction submit --tx-file "$CW/create.signed" --testnet-magic "$NET_MAGIC"
echo "created empty pool in tx $CREATE_TXID — waiting for confirmation…"

# ---- 4. wait for the pool UTXO to appear at POOL_ADDR ------------------------
POOL_UTXO=""
for _ in $(seq 1 40); do
  POOL_UTXO=$(cli query utxo --address "$POOL_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
    | POL="$POOL_POLICY" python3 -c "
import sys,json,os
u=json.load(sys.stdin); pol=os.environ['POL']; NFT='4e4654'
print(next((k for k,v in u.items() if v['value'].get(pol,{}).get(NFT,0)==1), ''))
")
  [ -n "$POOL_UTXO" ] && break
  sleep 5
done
[ -z "$POOL_UTXO" ] && { echo "pool UTXO never appeared — aborting close" >&2; exit 1; }
echo "pool UTXO = $POOL_UTXO"

# ---- 5. CLOSE it: spend pool (ClosePool) + burn NFT+LP (Close), creator signs -
echo '{"constructor":2,"fields":[]}' > "$CW/closepool.json"   # PoolRedeemer::ClosePool
echo '{"constructor":1,"fields":[]}' > "$CW/mintclose.json"   # MintRedeemer::Close

U2=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
read FUND2 COLL2 < <(echo "$U2" | python3 -c "
import sys,json
u=json.load(sys.stdin)
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
pures=sorted([k for k,v in u.items() if pure(v)], key=lambda k:u[k]['value']['lovelace'])
assert len(pures)>=2, 'need >=2 pure-ADA UTXOs for close (fund + collateral)'
print(pures[-1], pures[0])
")

cli transaction build \
  --tx-in "$POOL_UTXO" \
    --spending-tx-in-reference "$POOL_REF" \
    --spending-plutus-script-v3 \
    --spending-reference-tx-in-inline-datum-present \
    --spending-reference-tx-in-redeemer-file "$CW/closepool.json" \
  --tx-in "$FUND2" \
  --tx-in-collateral "$COLL2" \
  --mint "-1 $POOL_POLICY.$NFT_NAME+-$TOTAL_LP $POOL_POLICY.$LP_NAME" \
    --mint-script-file "$CW/pool_mint.plutus" \
    --mint-redeemer-file "$CW/mintclose.json" \
  --required-signer-hash "$SOLVER_PKH" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$CW/close.tx"
cli transaction sign --tx-file "$CW/close.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$CW/close.signed"
CLOSE_TXID=$(txid "$CW/close.signed")
cli transaction submit --tx-file "$CW/close.signed" --testnet-magic "$NET_MAGIC"
echo "CLOSED the empty pool in tx $CLOSE_TXID (burned {NFT:-1, LP:-total_lp}; ~2 ADA returned to solver)"
