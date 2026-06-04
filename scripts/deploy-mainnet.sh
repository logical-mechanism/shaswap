#!/usr/bin/env bash
#
# deploy-mainnet.sh — all-in-one ShaSwap MAINNET deploy.
#
# Runs the four steps in sequence: verify build → register S → publish reference scripts →
# verify on-chain. The actual logic lives in scripts/mainnet/lib.sh, shared with the
# human-paced step scripts (scripts/mainnet/0N-*.sh) so the confirmation-wait, idempotency,
# and verification logic exists in exactly ONE place.
#
# This is a ONE-SHOT, NO-TAKE-BACKS operation: the validators can never be patched. It is
# RESUMABLE — each chain step skips if already done and waits for confirmation before the
# next, so a crash/timeout is recovered by simply re-running. For step-by-step control
# (pausing and inspecting between each irreversible step), run scripts/mainnet/00..03 instead.
#
# Prerequisites (operator-supplied; nothing secret lives in the repo):
#   - A synced MAINNET cardano-node; CARDANO_NODE_SOCKET_PATH points at its socket.
#   - cardano-cli (era-grouped, v11+) and aiken on PATH.
#   - A funded mainnet wallet: DEPLOY_SKEY + DEPLOY_ADDR, with at least TWO ada-only UTXOs
#     (a funding input + a distinct collateral) totalling ~110 ADA + fees.
#
# Run:
#   CARDANO_NODE_SOCKET_PATH=/path/node.socket \
#   DEPLOY_SKEY=/secure/mainnet.skey DEPLOY_ADDR=$(cat /secure/mainnet.addr) \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE \
#   scripts/deploy-mainnet.sh
#
# See documentation/launch/mainnet-checklist.md for the full go-live gate.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/mainnet/lib.sh"

preflight
verify_build

cat <<PLAN

  ShaSwap MAINNET deployment plan
  ───────────────────────────────
  settlement (S / stake cred) : $S_HASH
  order validator             : $ORDER_HASH
  pool validator              : $POOL_HASH
  funding wallet              : $DEPLOY_ADDR
  will: (1) register S (Conway script-witnessed cert; publish handler authorizes registration only)
        (2) publish settlement/pool/order as reference scripts (one tx: #0/#1/#2)
        (3) verify all of the above on-chain
  resumable: already-done steps are skipped; safe to re-run after any interruption.
PLAN
read -r -p "  Type 'deploy' to proceed: " ANS; [ "$ANS" = deploy ] || die "aborted by operator."

register_s
publish_refs
verify_onchain

REFS_TXID=$(python3 -c "import json;print(json.load(open('$WORK/refs.json'))['settlement_ref']['tx_id'])")
cat <<NEXT

==> done + verified. Wire the clients to these refs (deploy tx $REFS_TXID):
    - app/src/lib/chain/deployment.ts  → mainnet: orderRef={tx:$REFS_TXID,#2}, poolRef={tx:$REFS_TXID,#1}, deployed:true
    - .do/app.mainnet.yaml             → NEXT_PUBLIC_NETWORK=mainnet (+ mainnet Blockfrost key in DO console)
    - batcher deployment.mainnet.json  → settlement_ref #0 / pool_ref #1 / order_ref #2 = $REFS_TXID
    Then bootstrap liquidity + the verified-pool list, and run >=2 batchers.
    Full gate: documentation/launch/mainnet-checklist.md
NEXT
