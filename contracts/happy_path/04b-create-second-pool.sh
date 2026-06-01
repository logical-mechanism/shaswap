#!/usr/bin/env bash
# Create + seed a SECOND TEST/ADA pool — same pair, a DIFFERENT one-shot NFT (new
# seed → new pool_mint policy), with different reserves (hence a different price).
# Proves the batcher handles multiple pools under the same anchor S with no
# per-pool config. Writes work/pool2.json. Mirrors 04 but picks UTXOs to fit a
# wallet that has a TEST-bearing change UTXO + a dedicated collateral.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

TEST_POLICY=$(cat "$WORK/test-policy.id")
TEST_NAME_HEX="54455354"
RES_A=500000000           # TEST reserve (asset_a)
RES_B=300000000           # ADA reserve (asset_b), lovelace (on top of pool_min_ada)
POOL_ADA=$((RES_B + POOL_MIN_ADA))

U=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json)
read SEED TESTU COLL < <(echo "$U" | TEST_POLICY="$TEST_POLICY" python3 -c "
import sys,json,os
u=json.load(sys.stdin); tp=os.environ['TEST_POLICY']
def pure(v): return list(v['value'])==['lovelace'] and not v.get('referenceScript')
def hastest(v): return any(p==tp for p in v['value'])
def isref(v): return bool(v.get('referenceScript'))
test=[k for k,v in u.items() if hastest(v)]
coll=sorted([k for k,v in u.items() if pure(v)], key=lambda k:u[k]['value']['lovelace'])[0]
# seed = any non-ref UTXO that is neither the collateral nor the TEST holder.
seed=[k for k,v in u.items() if not isref(v) and k!=coll and k not in test]
print(seed[0], test[0], coll)
")
echo "seed=$SEED  test_in/fund=$TESTU  collateral=$COLL"

SEED_TX=${SEED%%#*}; SEED_IX=${SEED##*#}
IDX_CBOR=$(python3 -c "i=$SEED_IX; print(format(i,'02x') if i<24 else ('18'+format(i,'02x')))")
SEED_PARAM="d8799f5820${SEED_TX}${IDX_CBOR}ff"
echo "pool_mint seed param = $SEED_PARAM"
aiken blueprint apply -i "$HP_DIR/../plutus.json" -m pool_mint -v pool_mint "$SEED_PARAM" -o "$WORK/pool_mint2.bp.json" >/dev/null 2>&1
mkdir -p "$WORK/pmbp2"; cp "$WORK/pool_mint2.bp.json" "$WORK/pmbp2/plutus.json"
aiken blueprint convert "$WORK/pmbp2" -m pool_mint -v pool_mint --to cardano-cli > "$WORK/pool_mint2.plutus"
POOL_POLICY=$(cardano-cli latest transaction policyid --script-file "$WORK/pool_mint2.plutus")
echo "pool2 policy (= pool NFT/LP policy) = $POOL_POLICY"

cat > "$WORK/pool2.datum.json" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":0,"fields":[{"bytes":"$TEST_POLICY"},{"bytes":"$TEST_NAME_HEX"}]},
  {"constructor":0,"fields":[{"bytes":""},{"bytes":""}]},
  {"int":3},{"int":1000},
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]}
]}
JSON
echo '{"constructor":0,"fields":[]}' > "$WORK/create.redeemer.json"

POOL_VALUE="$POOL_ADA+1 $POOL_POLICY.$NFT_NAME+$TOTAL_LP $POOL_POLICY.$LP_NAME+$RES_A $TEST_POLICY.$TEST_NAME_HEX"

cli transaction build \
  --tx-in "$SEED" \
  --tx-in "$TESTU" \
  --tx-in-collateral "$COLL" \
  --mint "1 $POOL_POLICY.$NFT_NAME+$TOTAL_LP $POOL_POLICY.$LP_NAME" \
  --mint-script-file "$WORK/pool_mint2.plutus" \
  --mint-redeemer-file "$WORK/create.redeemer.json" \
  --tx-out "$POOL_ADDR+$POOL_VALUE" \
  --tx-out-inline-datum-file "$WORK/pool2.datum.json" \
  --change-address "$SOLVER_ADDR" \
  --testnet-magic "$NET_MAGIC" \
  --out-file "$WORK/pool2.tx"

cli transaction sign --tx-file "$WORK/pool2.tx" --signing-key-file "$SOLVER_SKEY" \
  --testnet-magic "$NET_MAGIC" --out-file "$WORK/pool2.signed"
TXID=$(txid "$WORK/pool2.signed")
cli transaction submit --tx-file "$WORK/pool2.signed" --testnet-magic "$NET_MAGIC"
echo "second pool created in tx $TXID (policy $POOL_POLICY)"
echo "$POOL_POLICY" > "$WORK/pool2.policy"
