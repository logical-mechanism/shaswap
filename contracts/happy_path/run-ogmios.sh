#!/usr/bin/env bash
# Launch Ogmios against the local preprod node. Ogmios speaks JSON-RPC over
# HTTP/WebSocket on :1337 — the batcher's `chain` backend uses it for tip,
# protocol params (incl. the PlutusV3 cost model), EvaluateTx (the pre-submit
# gate), and submit. Runs in the foreground; Ctrl-C to stop (use `&` or a
# terminal multiplexer to background it).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

exec "$OGMIOS" \
  --node-socket "$CARDANO_NODE_SOCKET_PATH" \
  --node-config "$NODE_CONFIG" \
  --host 127.0.0.1 \
  --port 1337
