#!/usr/bin/env bash
# Shared environment for the ShaSwap preprod bootstrap/test scripts.
# Source it:  `source env.sh`  (or it is sourced by the numbered scripts).
#
# Everything here is derived/public (script hashes, addresses, constants) — NO
# secrets. The solver signing key lives OUTSIDE the repo (see SOLVER_SKEY) and is
# never committed. Paths are overridable via the environment; defaults match this
# machine's layout.
set -euo pipefail

# --- machine-local overrides (gitignored) --------------------------------------
# Put your real node/keys paths in env.local.sh next to this file; the defaults
# below are placeholders so the repo carries no machine-local paths.
_HP_ENV_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/env.local.sh"
[ -f "$_HP_ENV_LOCAL" ] && source "$_HP_ENV_LOCAL"

# --- node / tooling (assumption: the node is already running) -----------------
: "${NET_MAGIC:=1}"   # preprod
: "${CARDANO_NODE_SOCKET_PATH:=${HOME}/cardano-preprod/node-preprod/db-testnet/node.socket}"
: "${NODE_CONFIG:=${HOME}/cardano-preprod/node-preprod/config.json}"
: "${TESTNET_BIN:=${HOME}/cardano-preprod/bin}"
: "${KEYS_DIR:=${HOME}/cardano-preprod/keys}"
export CARDANO_NODE_SOCKET_PATH
export OGMIOS="$TESTNET_BIN/ogmios"
export KUPO="$TESTNET_BIN/kupo"

# --- this directory -----------------------------------------------------------
HP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export HP_DIR
export SCRIPTS="$HP_DIR/scripts"
export WORK="$HP_DIR/work"        # tx drafts, protocol params, deployment.json (gitignored)
mkdir -p "$WORK"

# --- solver / bootstrap wallet (signing key is OUTSIDE the repo) --------------
export SOLVER_SKEY="$KEYS_DIR/solver.skey"
export SOLVER_VKEY="$KEYS_DIR/solver.vkey"
export SOLVER_ADDR="$(cat "$KEYS_DIR/solver.addr")"
export SOLVER_PKH="$(cardano-cli latest address key-hash --payment-verification-key-file "$SOLVER_VKEY")"

# Solver STAKE key (OUTSIDE the repo). Used as the order owner_stake so settled
# funds land at a BASE address (payment = solver vkey, stake = this) — proving the
# base-address payout (Rev 21). Guarded so sourcing works before it's generated.
export SOLVER_STAKE_SKEY="$KEYS_DIR/solver-stake.skey"
export SOLVER_STAKE_VKEY="$KEYS_DIR/solver-stake.vkey"
[ -f "$SOLVER_STAKE_VKEY" ] && export SOLVER_STAKE_PKH="$(cardano-cli latest stake-address key-hash --stake-verification-key-file "$SOLVER_STAKE_VKEY")" || true

# --- a separate USER wallet (a trader, distinct from the solver) --------------
# Created by u1-setup-user.sh. Exports are guarded so sourcing works before it
# exists. Lets tests run with the realistic split: users post orders + pay only
# their order-creation fee; the solver settles + pays the settlement fee + earns tips.
export USER_SKEY="$KEYS_DIR/user.skey"
export USER_VKEY="$KEYS_DIR/user.vkey"
[ -f "$KEYS_DIR/user.addr" ] && export USER_ADDR="$(cat "$KEYS_DIR/user.addr")" || true
[ -f "$USER_VKEY" ] && export USER_PKH="$(cardano-cli latest address key-hash --payment-verification-key-file "$USER_VKEY")" || true

# --- scripts (settlement unparameterised; order/pool/lp_intent parameterised by S) ----
export SETTLEMENT_SCRIPT="$SCRIPTS/settlement.plutus"
export ORDER_SCRIPT="$SCRIPTS/order.plutus"
export POOL_SCRIPT="$SCRIPTS/pool.plutus"
export LP_INTENT_SCRIPT="$SCRIPTS/lp_intent.plutus"

# --- identities (derived; see also deployment.json) — Rev 29 H-01 partial fork ----------
# pool re-hashed (audit H-01: pool_settle self-tag + held-LP pin); settlement (S), order,
# and lp_intent are BYTE-IDENTICAL to the Rev 25 set. Applied hashes cross-verified:
# `aiken blueprint apply` of Credential::Script(S) reproduces the known order/lp_intent
# hashes; pool keeps the S stake credential, only its payment hash changed (34b30c7a→757ba6b7).
export S_HASH="a305a3cfd8343c03abffa0ef2b3ab6c756557a0dc5fb298c747259ea"          # settlement (= stake credential S)
export ORDER_HASH="e7fa1a385a04c103ece6746bc15b8e71cdf1ccb6854dbd3524fb148d"      # order(S)
export POOL_HASH="757ba6b73922bc98824661bf4deb90e6a061041705c032ace755afd3"       # pool(S) — Rev 29 (H-01; was 34b30c7a)
export LP_INTENT_HASH="fa885b037442ac10e65e7b1aeb6056f350446446ea51d92878240e5d"  # lp_intent(S) — Rev 25
export S_STAKE_ADDR="$(cat "$SCRIPTS/settlement.stake.addr")"                     # reward account for S
export ORDER_ADDR="$(cat "$SCRIPTS/order.addr")"                                  # where orders live (tagged S)
export POOL_ADDR="$(cat "$SCRIPTS/pool.addr")"                                    # where the pool lives (tagged S)
export LP_INTENT_ADDR="$(cat "$SCRIPTS/lp_intent.addr")"                          # where LP intents live (enterprise, NOT S-tagged)

# --- protocol constants (MUST equal contracts/lib/shaswap/constants.ak) --------
export NFT_NAME="4e4654"            # "NFT"
export LP_NAME="4c50"              # "LP"
export TOTAL_LP="9223372036854775807"
export MIN_LIQ="1000"
export POOL_MIN_ADA="2000000"
export ORDER_MIN_ADA="2000000"

cli() { cardano-cli latest "$@"; }   # cardano-cli 11 groups era subcommands

# `transaction txid` prints JSON ({"txhash": "..."}) in cardano-cli 11; extract the bare hash.
txid() {
  cli transaction txid --tx-file "$1" \
    | python3 -c "import sys,json;s=sys.stdin.read().strip();print(json.loads(s)['txhash'] if s.startswith('{') else s)"
}
