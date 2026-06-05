#!/usr/bin/env bash
# [1/3] MAINNET — register the settlement stake credential S (Conway script-witnessed cert;
# the publish handler authorizes registration only — never delegation/de-registration).
# Idempotent: skips if S is already registered. Waits for confirmation before returning.
#
#   CARDANO_NODE_SOCKET_PATH=… DEPLOY_SKEY=… DEPLOY_ADDR=… \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE scripts/mainnet/01-register-s.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib.sh"
preflight
register_s
echo "S registered — proceed to 02-deploy-refs.sh"
