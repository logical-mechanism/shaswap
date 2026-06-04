#!/usr/bin/env bash
# [0/3] MAINNET — verify the build is reproducible and the audited bytecode matches.
# Read-only (no chain writes). Run this before 01. See documentation/launch/mainnet-checklist.md.
#
#   CARDANO_NODE_SOCKET_PATH=… DEPLOY_SKEY=… DEPLOY_ADDR=… \
#   MAINNET_CONFIRM=I_UNDERSTAND_THIS_IS_IRREVERSIBLE scripts/mainnet/00-verify-build.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/lib.sh"
preflight
verify_build
echo "build verified — proceed to 01-register-s.sh"
