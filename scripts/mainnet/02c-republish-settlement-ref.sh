#!/usr/bin/env bash
# MAINNET — republish the SETTLEMENT reference script (incident 2026-06-10).
#
# What happened: 02b-fork-pool-ref.sh's funding picker selected the largest wallet UTXO,
# which was the 60-ADA UTXO carrying the settlement reference script (d56e729c#0). Spending
# it melted the ref into change (tx bfce12e4) — every settlement tx then failed assembly
# with Ogmios "missing script (withdraw)" / "Unknown transaction input d56e729c#0".
#
# What this does NOT mean: the settlement validator itself is unharmed. Its hash
# (a305a3cf…) is immutable, `S` remains registered, and no user funds were ever at risk —
# the batcher's pre-submit gate rejected every malformed tx. Only the convenience
# reference UTXO was destroyed, and anyone may publish a new one. The picker is now
# hardened (ada-only, ref-free UTXOs) so this cannot recur.
#
# This step:
#   1. verify_build — reproducible plutus.json + all four audited script hashes.
#   2. republish_settlement_ref — publish a fresh settlement ref (idempotent: if a
#      DEPLOY_ADDR UTXO already carries a ref hashing to S, it records that and makes NO
#      new tx), wait for confirmation, re-verify the on-chain ref hash.
#   3. print the ref to wire into the batcher (deployment.mainnet.json settlement_ref).
#      Written to scripts/work-mainnet/settlement-ref.json. The app never uses a
#      settlement ref (it builds no settlement txs), so no app change.
#
# Run on the funded mainnet deploy server (the one that did d56e729c + bfce12e4):
#   CARDANO_NODE_SOCKET_PATH=/path/to/mainnet/node.socket \
#   DEPLOY_SKEY=/path/to/deploy.skey DEPLOY_ADDR=addr1... \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE \
#   scripts/mainnet/02c-republish-settlement-ref.sh
#
# Idempotent + resumable: if interrupted, just re-run — a confirmed settlement ref is
# detected and recorded without a second tx.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib.sh"

preflight
verify_build
republish_settlement_ref

echo
echo "===================================================================================="
echo " settlement ref republished. Wire it into the batcher, then restart it:"
python3 - <<PY
import json
d = json.load(open("$WORK/settlement-ref.json"))["settlement_ref"]
print(f"   batcher  deployment.mainnet.json  settlement_ref:")
print(f'       {{ "tx_id": "{d["tx_id"]}", "index": {d["index"]} }}')
print()
print(f"   while you are in that file, the full correct mainnet ref set is:")
print(f'       "settlement_ref": {{ "tx_id": "{d["tx_id"]}", "index": {d["index"]} }},')
print(f'       "pool_ref":       {{ "tx_id": "bfce12e4fa296212608808b35fc697b6d251a820e1025cb2486b05ce64b5d92d", "index": 0 }},')
print(f'       "order_ref":      {{ "tx_id": "d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb", "index": 2 }},')
print(f'       "lp_intent_ref":  {{ "tx_id": "d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb", "index": 3 }}')
PY
echo "===================================================================================="
