#!/usr/bin/env bash
# [2/3] MAINNET — publish settlement/pool/order as on-chain reference scripts (one tx:
# settlement #0, pool #1, order #2). Idempotent: skips if already on-chain. Writes the
# refs to scripts/work-mainnet/refs.json and waits for confirmation. Run 01 first.
#
#   CARDANO_NODE_SOCKET_PATH=… DEPLOY_SKEY=… DEPLOY_ADDR=… \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE scripts/mainnet/02-deploy-refs.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib.sh"
preflight
publish_refs
echo "refs published — proceed to 03-verify-onchain.sh"
