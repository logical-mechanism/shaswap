#!/usr/bin/env bash
# Create + seed a TEST/ADA pool. Consumes a seed UTXO, mints {NFT:1, LP:total_lp}
# via the one-shot pool_mint(seed) policy (Create redeemer), and locks them with the
# reserves + a well-formed PoolDatum at the pool address (tagged S). asset_a = TEST,
# asset_b = ADA. Writes work/pool.json (policy, nft, datum, creation utxo).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"
: "${RES_A:=1000000000}"   # TEST reserve (asset_a) — env-overridable for smaller test pools
: "${RES_B:=1000000000}"   # ADA reserve (asset_b), lovelace (on top of pool_min_ada)
POOL_ADA=$((RES_B + POOL_MIN_ADA))

U=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
read SEED TESTU FUND COLL < <(echo "$U" | TEST_POLICY="$TEST_POLICY" python3 -c "
import sys,json,os
u=json.load(sys.stdin); tp=os.environ['TEST_POLICY']
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
def hastest(v): return any(p==tp for p in v['value'])
test=[k for k,v in u.items() if hastest(v)]
pures=sorted([k for k,v in u.items() if pure(v)], key=lambda k:u[k]['value']['lovelace'])
small=[k for k in pures if u[k]['value']['lovelace']<=10_000_000]
fund=pures[-1]
seed=small[0]; coll=small[1]
print(seed, test[0], fund, coll)
")
echo "seed=$SEED  test_in=$TESTU  fund=$FUND  collateral=$COLL"

# pool_mint(seed) -> one-shot policy. seed OutputReference = Constr0[bytes txid, int idx].
SEED_TX=${SEED%%#*}; SEED_IX=${SEED##*#}
IDX_CBOR=$(python3 -c "i=$SEED_IX; print(format(i,'02x') if i<24 else ('18'+format(i,'02x')))")
SEED_PARAM="d8799f5820${SEED_TX}${IDX_CBOR}ff"
echo "pool_mint seed param = $SEED_PARAM"
aiken blueprint apply -i "$HP_DIR/../plutus.json" -m pool_mint -v pool_mint "$SEED_PARAM" -o "$WORK/pool_mint.bp.json" >/dev/null 2>&1
mkdir -p "$WORK/pmbp"; cp "$WORK/pool_mint.bp.json" "$WORK/pmbp/plutus.json"
aiken blueprint convert "$WORK/pmbp" -m pool_mint -v pool_mint --to cardano-cli > "$WORK/pool_mint.plutus"
POOL_POLICY=$(cardano-cli latest transaction policyid --script-file "$WORK/pool_mint.plutus")
echo "pool policy (= pool NFT/LP policy) = $POOL_POLICY"

# PoolDatum: nft, asset_a=TEST, asset_b=ADA, fee 3/1000, creator=VK(solver)
cat > "$WORK/pool.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":0,"fields":[{"bytes":"$TEST_POLICY"},{"bytes":"$TEST_NAME_HEX"}]},
  {"constructor":0,"fields":[{"bytes":""},{"bytes":""}]},
  {"int":3},{"int":1000},
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]}
]}
JSON
echo '{"constructor":0,"fields":[]}' > "$WORK/create.redeemer.json"   # MintRedeemer::Create

POOL_VALUE="$POOL_ADA+1 $POOL_POLICY.$NFT_NAME+$TOTAL_LP $POOL_POLICY.$LP_NAME+$RES_A $TEST_POLICY.$TEST_NAME_HEX"

cli transaction build \
  --tx-in "$SEED" \
  --tx-in "$TESTU" \
  --tx-in "$FUND" \
  --tx-in-collateral "$COLL" \
  --mint "1 $POOL_POLICY.$NFT_NAME+$TOTAL_LP $POOL_POLICY.$LP_NAME" \
  --mint-script-file "$WORK/pool_mint.plutus" \
  --mint-redeemer-file "$WORK/create.redeemer.json" \
  --tx-out "$POOL_ADDR+$POOL_VALUE" \
  --tx-out-inline-datum-file "$WORK/pool.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/pool.tx"

cli transaction sign --tx-file "$WORK/pool.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/pool.signed"
TXID=$(txid "$WORK/pool.signed")
cli transaction submit --tx-file "$WORK/pool.signed" --testnet-magic "$NET_MAGIC"
echo "pool created in tx $TXID"

python3 - "$POOL_POLICY" "$TEST_POLICY" "$TXID" > "$WORK/pool.json" <<'PY'
import sys,json
pol,test,txid=sys.argv[1:4]
json.dump({"pool_policy":pol,"nft":{"policy":pol,"name":"4e4654"},"lp":{"policy":pol,"name":"4c50"},
           "asset_a":{"policy":test,"name":"54455354"},"asset_b":{"policy":"","name":""},
           "create_tx":txid},sys.stdout,indent=2)
PY
echo "wrote $WORK/pool.json"
