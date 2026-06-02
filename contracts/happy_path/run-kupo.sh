#!/usr/bin/env bash
# Launch Kupo against the local preprod node. Kupo is a lightweight chain-indexer;
# the batcher's `chain` backend queries its REST API on :1442 to discover order +
# pool UTXOs (with their inline datums) by the settlement stake credential `S`.
#
# Match patterns (Kupo `--match`):
#   - `*/<S_HASH>`  — ANY payment credential delegated to S. Order AND pool UTXOs
#     are both stake-tagged with S (BLUEPRINT §5.4), so this one pattern finds
#     both. Owner payouts now carry the owner's chosen stake credential (a base
#     address, Rev 21) — intentionally NOT matched (they're not protocol UTXOs).
#   - SOLVER_ADDR   — the solver's own wallet, for funding/collateral selection.
#
# Stale-index auto-cleanup (the redeploy problem): Kupo refuses to reuse a workdir
# whose stored match patterns differ from the CLI ones ("ConflictingOptions"). A
# REDEPLOY changes the settlement script hash `S`, so the `*/<S>` pattern changes and
# the prior index becomes stale. We detect that (the db doesn't index our *current*
# `S`) and rebuild the workdir automatically — fast-forwarding from the old index's
# last checkpoint so it's seconds, not a full origin re-sync. Knobs:
#   - KUPO_RESET=1     force a rebuild even if the patterns match.
#   - KUPO_SINCE=...   override the start point (`origin` | `<slot>.<headerhash>`).
#     On an auto-rebuild we default it to the previous index's last checkpoint; pass
#     `origin` instead if your redeploy is OLDER than that slot (so nothing is missed).
#
# `--since` only seeds an EMPTY index; once the db holds the pool, later runs resume
# from the stored checkpoint automatically (the value is then ignored).
source "$(dirname "${BASH_SOURCE[0]:-$0}")/env.sh"

: "${KUPO_WORKDIR:=$WORK/kupo-db}"
DB="$KUPO_WORKDIR/kupo.sqlite3"
WANT_PATTERN="*/$S_HASH"

# --- detect a stale index (a different deployment) ----------------------------
stale=""
if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  have=$(sqlite3 "$DB" "SELECT 1 FROM patterns WHERE pattern='$WANT_PATTERN' LIMIT 1;" 2>/dev/null || true)
  [ -z "$have" ] && stale="index does not track S=$S_HASH (redeployed?)"
fi
[ -n "${KUPO_RESET:-}" ] && stale="KUPO_RESET set"

# --- rebuild the workdir on a stale/forced index, fast-forwarding when we can --
if [ -n "$stale" ]; then
  salvage=""
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
    salvage=$(sqlite3 "$DB" \
      "SELECT slot_no || '.' || lower(hex(header_hash)) FROM checkpoints ORDER BY slot_no DESC LIMIT 1;" \
      2>/dev/null || true)
  fi
  echo "kupo: rebuilding stale index ($stale) at $KUPO_WORKDIR"
  rm -rf "$KUPO_WORKDIR"
  if [ -z "${KUPO_SINCE:-}" ] && [ -n "$salvage" ]; then
    KUPO_SINCE="$salvage"
    echo "kupo: fast-forwarding from the previous index's last checkpoint ($salvage)."
    echo "      If your redeploy is OLDER than that slot, re-run with KUPO_SINCE=origin."
  fi
fi

: "${KUPO_SINCE:=origin}"
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
