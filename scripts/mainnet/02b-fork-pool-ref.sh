#!/usr/bin/env bash
# MAINNET — H-01 partial fork (Rev 29): publish ONLY the new `pool` reference script.
#
# Only the pool validator changed (audit H-01: pool_settle S-tag self-check + held-LP pin).
# The existing settlement/order/lp_intent reference scripts (deploy d56e729c) are NOT touched.
# This step:
#   1. verify_build — reproducible plutus.json + all four script hashes (pool now = the
#      H-01 hash 757ba6b7…; settlement/order/lp_intent unchanged).
#   2. fork_pool_ref — publish the new pool ref (idempotent: skips + records if already
#      on-chain), wait for confirmation, re-verify the on-chain ref hash.
#   3. print the ref so you can wire it into the app (deployment.ts mainnet poolRef) and the
#      batcher (deployment.mainnet.json pool_ref). Written to scripts/work-mainnet/pool-ref.json.
#
# Run on the funded mainnet deploy server (the one that did d56e729c):
#   CARDANO_NODE_SOCKET_PATH=/path/to/mainnet/node.socket \
#   DEPLOY_SKEY=/path/to/deploy.skey DEPLOY_ADDR=addr1... \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE \
#   scripts/mainnet/02b-fork-pool-ref.sh
#
# Idempotent + resumable: if interrupted, just re-run — a confirmed pool ref is detected and
# recorded without a second tx.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib.sh"

preflight
verify_build
fork_pool_ref

echo
echo "===================================================================================="
echo " pool ref published. Wire it into the clients, then PR to dev:"
python3 - <<PY
import json
d = json.load(open("$WORK/pool-ref.json"))["pool_ref"]
print(f"   app  src/lib/chain/deployment.ts  mainnet.poolRef:")
print(f'       {{ txHash: "{d["tx_id"]}", outputIndex: {d["index"]} }}')
print(f"   batcher  deployment.mainnet.json  pool_ref:")
print(f'       {{ "tx_id": "{d["tx_id"]}", "index": {d["index"]} }}')
print()
print(f"   also set (already known, no tx needed):")
print(f"       app  mainnet.poolScriptHash = 757ba6b73922bc98824661bf4deb90e6a061041705c032ace755afd3")
print(f"       app  mainnet.poolScriptSize = 3028")
print(f"       batcher pool_script_hash    = 757ba6b73922bc98824661bf4deb90e6a061041705c032ace755afd3")
PY
echo "===================================================================================="
