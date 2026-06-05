#!/usr/bin/env bash
# [3/3] MAINNET — verify the deployed reference scripts on-chain by re-hashing them and
# comparing to the audited hashes. Read-only; dies on any mismatch. Reads the refs from
# scripts/work-mainnet/refs.json (written by 02). On success prints REFS_TXID to wire
# into the clients (deployment.ts / .do / batcher deployment.json).
#
#   CARDANO_NODE_SOCKET_PATH=… DEPLOY_SKEY=… DEPLOY_ADDR=… \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE scripts/mainnet/03-verify-onchain.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib.sh"
preflight
verify_onchain
echo "verified — wire the printed REFS_TXID per documentation/launch/mainnet-checklist.md §2"
