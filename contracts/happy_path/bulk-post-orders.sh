#!/usr/bin/env bash
# Bulk-post N test orders against the TEST/ADA pool so the batcher has a real
# batch to settle (more than one order per settlement tx). Mirrors 05-post-order.sh
# (token-seller, sell_a=True) and 05b-post-ada-order.sh (ada-seller, sell_a=False),
# but emits MANY orders at once — by default a BALANCED mix (half sell TEST→ADA,
# half sell ADA→TEST) so the orders net against each other and the pool barely
# moves, keeping a large batch settleable.
#
# Per-order amounts (sell sizes + tips) are JITTERED around the base by ±--jitter%
# from a SEEDED PRNG, so the book is heterogeneous (exercises the solver's netting,
# per-order floors, and proportional tip-take) yet a given --seed is reproducible.
# Use --jitter 0 for identical orders.
#
# Each order is a plain payment to the order script address with an inline
# OrderDatum — no script runs at creation, so no collateral is needed. Every order
# in a tx gets a distinct OutputReference (same tx id, distinct output index), which
# is exactly the injective order→output key the settlement validator uses (§5.2.6).
#
# Funding: from the SOLVER wallet, preferring its TEST-bearing UTXO (it carries both
# the TEST to sell and the lovelace for the order min-ADA + tips). The batcher funds
# only from ada-only UTXOs (its dust/token-poisoning guard), so as long as the TEST
# UTXO covers the whole batch the poster and a concurrently-running batcher never
# contend for the same input. If the batch needs more ADA than the TEST UTXO holds,
# extra ada UTXOs are pulled in and a submit may briefly race the batcher — just rerun.
#
# Settlement note: the batcher is BLOCK-DRIVEN — it discovers orders from one Kupo
# snapshot per block and drains the whole settleable orderbook for that snapshot in a
# single pass (up to max_orders_per_tx=20 per settlement tx, chaining the rest). So
# all orders posted in ONE tx (≤ --per-tx, the common case) land in one block and get
# batched together that pass. When N > --per-tx the orders are posted over several txs,
# confirmed between chunks, and so may land in DIFFERENT blocks — the batcher may then
# settle them across separate passes, not as one combined batch. Keep N ≤ --per-tx
# (≈ one ~16KB tx) if you want a single coherent batch.
#
# Usage:
#   bulk-post-orders.sh [N] [options]
#     N                       total orders to post           (default 10)
#   options:
#     --sell-test  AMOUNT     base TEST each token-seller sells (default 5000000)
#     --sell-ada   LOVELACE   base ADA  each ada-seller sells   (default 5000000)
#     --tip        LOVELACE   base solver tip per order         (default 2000000)
#     --jitter     PCT        ± random variance on sells+tips   (default 40; 0=off)
#     --seed       N          PRNG seed (reproducible draws)    (default 42)
#     --mix        MODE       balanced | token | ada            (default balanced)
#     --slippage   PCT        per-order floor = PCT below spot  (default 30)
#     --per-tx     K          max orders per posting tx         (default 40)
#     --pool-policy HEX       target pool NFT policy          (default work/pool.json)
#     --dry-run               build + print the first tx + its plan; do NOT submit
#     -h | --help
#
# Examples:
#   bulk-post-orders.sh 23                 # 12 TEST→ADA + 11 ADA→TEST, jittered, one tx
#   bulk-post-orders.sh 23 --jitter 0      # identical sizes (perfect netting)
#   bulk-post-orders.sh 23 --seed 7        # a different reproducible draw
#   bulk-post-orders.sh 10 --mix token --dry-run   # inspect the plan, don't submit
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

# --- defaults -----------------------------------------------------------------
N=10
SELL_TEST=5000000
SELL_ADA=5000000
TIP=2000000
JITTER=40
SEED=42
MIX=balanced
SLIPPAGE=30
PER_TX=40          # orders per posting tx; ~40 fits one ~16KB tx (one block)
POOL_POLICY=""
DRY_RUN=0
FEE_BUFFER=3000000          # headroom for the tx fee + the change min-ADA
TEST_NAME="54455354"        # "TEST"

# --- arg parse ----------------------------------------------------------------
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then N="$1"; shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --sell-test)   SELL_TEST="$2"; shift 2;;
    --sell-ada)    SELL_ADA="$2";  shift 2;;
    --tip)         TIP="$2";       shift 2;;
    --jitter)      JITTER="$2";    shift 2;;
    --seed)        SEED="$2";      shift 2;;
    --mix)         MIX="$2";       shift 2;;
    --slippage)    SLIPPAGE="$2";  shift 2;;
    --per-tx)      PER_TX="$2";    shift 2;;
    --pool-policy) POOL_POLICY="$2"; shift 2;;
    --dry-run)     DRY_RUN=1;      shift;;
    -h|--help)     sed -n '2,56p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done
[ "$N" -ge 1 ] 2>/dev/null         || { echo "N must be a positive integer (got '$N')" >&2; exit 1; }
[ "$PER_TX" -ge 1 ] 2>/dev/null    || { echo "--per-tx must be >= 1" >&2; exit 1; }
{ [ "$JITTER" -ge 0 ] && [ "$JITTER" -le 95 ]; } 2>/dev/null \
                                    || { echo "--jitter must be 0..95 (got '$JITTER')" >&2; exit 1; }
[ "$SEED" -ge 0 ] 2>/dev/null      || { echo "--seed must be a non-negative integer" >&2; exit 1; }

# --- resolve the target pool + its live reserves ------------------------------
TEST_POLICY=$(cat "$WORK/test-policy.id")
if [ -z "$POOL_POLICY" ]; then
  POOL_POLICY=$(python3 -c "import json;print(json.load(open('$WORK/pool.json'))['pool_policy'])")
fi
echo "pool policy (NFT) = $POOL_POLICY"

# Read the pool UTXO (the one at POOL_ADDR holding the NFT) for spot price — each
# order's floor is set a slippage margin below spot (computed per order from its own
# jittered size), so the uniform batch price clears every floor at any pool ratio.
read RES_A RES_B SPOT_BA < <(
  cli query utxo --address "$POOL_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
  | POOL_POLICY="$POOL_POLICY" NFT_NAME="$NFT_NAME" TEST_POLICY="$TEST_POLICY" \
    TEST_NAME="$TEST_NAME" POOL_MIN_ADA="$POOL_MIN_ADA" python3 -c "
import sys, json, os
u = json.load(sys.stdin)
pp, nft = os.environ['POOL_POLICY'], os.environ['NFT_NAME']
tp, tn  = os.environ['TEST_POLICY'], os.environ['TEST_NAME']
pmin    = int(os.environ['POOL_MIN_ADA'])
pool = [v for v in u.values() if v['value'].get(pp, {}).get(nft, 0) == 1]
if not pool: sys.stderr.write('no pool UTXO with the NFT at the pool address\n'); sys.exit(2)
val = pool[0]['value']
res_a = int(val.get(tp, {}).get(tn, 0))   # TEST reserve (asset_a)
res_b = int(val['lovelace']) - pmin       # ADA  reserve (asset_b), net of min-ADA
if res_a <= 0 or res_b <= 0: sys.stderr.write('pool reserves not positive\n'); sys.exit(2)
print(res_a, res_b, f'{res_b/res_a:.6f}')
")
# `read` over a process substitution can't fail the script (set -e doesn't see it),
# so verify we actually got numeric reserves before building any plan.
if ! [[ "${RES_A:-}" =~ ^[0-9]+$ && "${RES_B:-}" =~ ^[0-9]+$ ]]; then
  echo "could not read pool reserves at $POOL_ADDR — is the pool created and the node synced?" >&2
  exit 1
fi
echo "pool reserves: ${RES_A} TEST / ${RES_B} ADA(lovelace)  | spot ≈ ${SPOT_BA} ADA/TEST"

# --- direction split ----------------------------------------------------------
case "$MIX" in
  balanced) N_TOKEN=$(( (N + 1) / 2 )); N_ADA=$(( N / 2 ));;
  token)    N_TOKEN=$N; N_ADA=0;;
  ada)      N_TOKEN=0;  N_ADA=$N;;
  *) echo "--mix must be balanced|token|ada (got '$MIX')" >&2; exit 1;;
esac

# --- build the per-order plan (direction, sell, floor, tip), jittered + seeded -
# One line per order, interleaved T/A so each posting chunk stays balanced. Floors
# are derived from each order's OWN jittered size, slippage below spot.
mapfile -t PLAN < <(
  N_TOKEN="$N_TOKEN" N_ADA="$N_ADA" SELL_TEST="$SELL_TEST" SELL_ADA="$SELL_ADA" \
  TIP="$TIP" JITTER="$JITTER" SEED="$SEED" SLIPPAGE="$SLIPPAGE" \
  RES_A="$RES_A" RES_B="$RES_B" python3 -c "
import os, random
nt, na = int(os.environ['N_TOKEN']), int(os.environ['N_ADA'])
st, sa = int(os.environ['SELL_TEST']), int(os.environ['SELL_ADA'])
tip    = int(os.environ['TIP'])
jit    = int(os.environ['JITTER']) / 100.0
slip   = int(os.environ['SLIPPAGE'])
ra, rb = int(os.environ['RES_A']), int(os.environ['RES_B'])
rng    = random.Random(int(os.environ['SEED']))
keep   = 100 - slip
def jitter(base):
    if jit <= 0: return base
    return max(1, rng.randint(int(base * (1 - jit)), int(base * (1 + jit))))
toks, adas = [], []
for _ in range(nt):
    s = jitter(st); lim = max(1, s * rb * keep // (ra * 100)); toks.append(('T', s, lim, jitter(tip)))
for _ in range(na):
    s = jitter(sa); lim = max(1, s * ra * keep // (rb * 100)); adas.append(('A', s, lim, jitter(tip)))
i = j = 0
while i < len(toks) or j < len(adas):
    if i < len(toks): print(*toks[i]); i += 1
    if j < len(adas): print(*adas[j]); j += 1
")
# Parse the plan into parallel arrays.
DIRS=(); SELLS=(); LIMITS=(); TIPS=()
for line in "${PLAN[@]}"; do
  read -r d s l t <<< "$line"
  DIRS+=("$d"); SELLS+=("$s"); LIMITS+=("$l"); TIPS+=("$t")
done
[ "${#DIRS[@]}" -eq "$N" ] || { echo "plan generation failed (got ${#DIRS[@]} of $N orders)" >&2; exit 1; }

if [ "$JITTER" -gt 0 ]; then VAR="±${JITTER}% (seed $SEED)"; else VAR="identical"; fi
echo "posting $N orders: $N_TOKEN token-seller (sell ~$SELL_TEST TEST) + $N_ADA ada-seller (sell ~$SELL_ADA ADA)"
echo "                   tip ~$TIP, variance $VAR, owner = solver, target NFT $POOL_POLICY"

# --- owner_stake = Some(VK(solver stake)) — base-address payout (Rev 21), exactly
# like 05/05b. (Orders with different owner_stake DO batch together — see u2's None
# vs 05's Some — so this is not about batch compatibility.) We pin Some here so the
# solver's settled funds return to its BASE address ($SOLVER_ADDR, the address this
# test and the batcher track), not an off-address enterprise payout. Require the
# stake key rather than silently falling back to None.
if [ -z "${SOLVER_STAKE_PKH:-}" ]; then
  echo "SOLVER_STAKE_PKH is unset — generate the solver stake key (see env.sh) so" >&2
  echo "settled funds land at the solver base address, as 05/05b require." >&2
  exit 1
fi
OWNER_STAKE='{"constructor":0,"fields":[{"constructor":0,"fields":[{"bytes":"'"$SOLVER_STAKE_PKH"'"}]}]}'

# Write one order's inline OrderDatum. OrderDatum (Constr0): owner, owner_stake,
# pool_nft, sell_a, sell_amount, limit, tip, partial(False), deadline(None). sell_a
# is an Aiken Bool: Constr1=True (sell asset_a=TEST), Constr0=False (sell asset_b=ADA).
# Args: sell_a_constr(1|0) sell limit tip outfile.
make_datum() {
  cat > "$5" <<JSON
{"constructor":0,"fields":[
  {"constructor":0,"fields":[{"bytes":"$SOLVER_PKH"}]},
  $OWNER_STAKE,
  {"constructor":0,"fields":[{"bytes":"$POOL_POLICY"},{"bytes":"$NFT_NAME"}]},
  {"constructor":$1,"fields":[]},
  {"int":$2},
  {"int":$3},
  {"int":$4},
  {"constructor":0,"fields":[]},
  {"constructor":1,"fields":[]}
]}
JSON
}

# Wait until tx TXID's outputs are visible at the solver address (its change), so the
# next chunk selects fresh, confirmed UTXOs.
wait_for_tx() {
  local txid="$1" tries=0
  echo "  waiting for $txid to confirm..."
  while true; do
    if cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
       | grep -q "\"$txid#"; then echo "  confirmed."; return 0; fi
    tries=$((tries + 1))
    [ "$tries" -gt 150 ] && { echo "  timed out waiting for $txid" >&2; return 1; }
    sleep 2
  done
}

# Post one chunk: orders at plan indices [s_idx, e_idx) in a single tx.
post_chunk() {
  local s_idx="$1" e_idx="$2" idx="$3" i need_test=0 need_ada=0 ct=0 ca=0
  local -a OUTS=()

  for ((i = s_idx; i < e_idx; i++)); do
    local df="$WORK/bulk-order.$idx.$i.datum.json"
    if [ "${DIRS[i]}" = T ]; then
      make_datum 1 "${SELLS[i]}" "${LIMITS[i]}" "${TIPS[i]}" "$df"
      OUTS+=(--tx-out "$ORDER_ADDR+$(( ORDER_MIN_ADA + TIPS[i] ))+${SELLS[i]} $TEST_POLICY.$TEST_NAME"
             --tx-out-inline-datum-file "$df")
      need_test=$(( need_test + SELLS[i] ))
      need_ada=$(( need_ada + ORDER_MIN_ADA + TIPS[i] ))
      ct=$((ct + 1))
    else
      make_datum 0 "${SELLS[i]}" "${LIMITS[i]}" "${TIPS[i]}" "$df"
      OUTS+=(--tx-out "$ORDER_ADDR+$(( SELLS[i] + ORDER_MIN_ADA + TIPS[i] ))"
             --tx-out-inline-datum-file "$df")
      need_ada=$(( need_ada + SELLS[i] + ORDER_MIN_ADA + TIPS[i] ))
      ca=$((ca + 1))
    fi
    [ "$DRY_RUN" = 1 ] && printf "    order %d: %s sell=%s floor=%s tip=%s\n" \
      "$i" "${DIRS[i]}" "${SELLS[i]}" "${LIMITS[i]}" "${TIPS[i]}"
  done
  need_ada=$(( need_ada + FEE_BUFFER ))

  # Select solver inputs covering TEST first (prefers the TEST-bearing UTXO, which
  # the batcher never funds from), then top up ADA only if still short.
  local sel
  sel=$(cli query utxo --address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --output-json \
    | TEST_POLICY="$TEST_POLICY" TEST_NAME="$TEST_NAME" \
      NEED_TEST="$need_test" NEED_ADA="$need_ada" python3 -c "
import sys, json, os
u = json.load(sys.stdin)
tp, tn = os.environ['TEST_POLICY'], os.environ['TEST_NAME']
need_test, need_ada = int(os.environ['NEED_TEST']), int(os.environ['NEED_ADA'])
def is_ref(v): return bool(v.get('referenceScript'))
def test_of(v): return int(v['value'].get(tp, {}).get(tn, 0))
def ada_of(v):  return int(v['value']['lovelace'])
items = [(k, v) for k, v in u.items() if not is_ref(v)]
chosen, at, aa = {}, 0, 0
for k, v in sorted(items, key=lambda kv: test_of(kv[1]), reverse=True):
    if at >= need_test: break
    if test_of(v) > 0: chosen[k] = v; at += test_of(v); aa += ada_of(v)
for k, v in sorted(items, key=lambda kv: ada_of(kv[1]), reverse=True):
    if aa >= need_ada: break
    if k in chosen: continue
    chosen[k] = v; aa += ada_of(v); at += test_of(v)
if at < need_test: sys.stderr.write(f'insufficient TEST: have {at}, need {need_test}\n'); sys.exit(2)
if aa < need_ada:  sys.stderr.write(f'insufficient ADA: have {aa}, need {need_ada}\n');  sys.exit(2)
print(' '.join(chosen))
")
  echo "  chunk $idx: ct=$ct ca=$ca | need ${need_test} TEST + ${need_ada} ADA | inputs: $sel"

  local -a INS=(); local ref
  for ref in $sel; do INS+=(--tx-in "$ref"); done

  local tx="$WORK/bulk-order.$idx.tx" signed="$WORK/bulk-order.$idx.signed"
  cli transaction build "${INS[@]}" "${OUTS[@]}" \
    --change-address "$SOLVER_ADDR" --testnet-magic "$NET_MAGIC" --out-file "$tx"

  if [ "$DRY_RUN" = 1 ]; then
    echo "  --dry-run: built $tx ($((ct + ca)) orders); not signing/submitting."
    return 10   # sentinel: stop the loop after the first chunk
  fi

  cli transaction sign --tx-file "$tx" --signing-key-file "$SOLVER_SKEY" \
    --testnet-magic "$NET_MAGIC" --out-file "$signed"
  local txh; txh=$(txid "$signed")   # txid() is the env.sh helper
  cli transaction submit --tx-file "$signed" --testnet-magic "$NET_MAGIC"
  echo "  chunk $idx posted $((ct + ca)) orders in tx $txh"
  LAST_TXID="$txh"
}

# --- drive the chunks ---------------------------------------------------------
total=${#DIRS[@]}
start=0; chunk=0; posted=0
while [ "$start" -lt "$total" ]; do
  chunk=$((chunk + 1))
  end=$((start + PER_TX)); [ "$end" -gt "$total" ] && end=$total
  set +e; post_chunk "$start" "$end" "$chunk"; rc=$?; set -e
  [ "$rc" = 10 ] && exit 0           # dry-run stopped after the first chunk
  [ "$rc" != 0 ] && { echo "chunk $chunk failed (rc=$rc)" >&2; exit "$rc"; }
  posted=$((posted + end - start))
  start=$end
  [ "$start" -lt "$total" ] && wait_for_tx "$LAST_TXID"   # confirm before next chunk
done

echo
echo "done: posted $posted orders to $ORDER_ADDR across $chunk tx(s)."
if [ "$chunk" -eq 1 ]; then
  echo "all in one tx/block: the batcher discovers them in a single pass and drains them"
  echo "in ~ceil($posted/20) chained settlement tx(s) (max_orders_per_tx=20)."
else
  echo "posted over $chunk txs (confirmed between chunks), so they may span blocks — the"
  echo "block-driven batcher may settle them across separate passes, not one batch. Use a"
  echo "larger --per-tx (≤ ~one 16KB tx) to keep them in a single block for one batch."
fi
echo "watch it on the batcher host, e.g.:"
echo "  SHASWAP_DEPLOYMENT=$HP_DIR/deployment.json SHASWAP_SUBMIT=1 \\"
echo "  SHASWAP_MAX_ORDERS_PER_TX=20 RUST_LOG=info ./target/release/shaswap-batcher"
