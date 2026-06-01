#!/usr/bin/env bash
# Launch Kupo against the local preprod node. Kupo is a lightweight chain-indexer;
# the batcher's `chain` backend queries its REST API on :1442 to discover order +
# pool UTXOs (with their inline datums) by the settlement stake credential `S`.
#
# Match patterns (Kupo `--match`):
#   - `*/<S_HASH>`  — ANY payment credential delegated to S. Order AND pool UTXOs
#     are both stake-tagged with S (BLUEPRINT §5.4), so this one pattern finds
#     both. Owner payouts (enterprise, stake=None) are intentionally NOT matched.
#   - SOLVER_ADDR   — the solver's own wallet, for funding/collateral selection.
#
# `--since`: Kupo only indexes blocks at/after this point. The pre-existing pool
# UTXO was created before "now", so a first run must sync from `origin` to capture
# it (a one-time ~minutes-long header sync on a local synced node). Once the index
# holds the pool, later runs can resume from the stored checkpoint automatically
# (just omit --since, or pass a recent point). Override with KUPO_SINCE=origin|<slot.hash>.
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

: "${KUPO_SINCE:=origin}"
: "${KUPO_WORKDIR:=$WORK/kupo-db}"
mkdir -p "$KUPO_WORKDIR"

exec "$KUPO" \
  --node-socket "$CARDANO_NODE_SOCKET_PATH" \
  --node-config "$NODE_CONFIG" \
  --host 127.0.0.1 \
  --port 1442 \
  --workdir "$KUPO_WORKDIR" \
  --since "$KUPO_SINCE" \
  --match "*/$S_HASH" \
  --match "$SOLVER_ADDR" \
  --defer-db-indexes
