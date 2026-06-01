#!/usr/bin/env bash
# Shared environment for the ShaSwap preprod bootstrap/test scripts.
# Source it:  `source env.sh`  (or it is sourced by the numbered scripts).
#
# Everything here is derived/public (script hashes, addresses, constants) — NO
# secrets. The solver signing key lives OUTSIDE the repo (see SOLVER_SKEY) and is
# never committed. Paths are overridable via the environment; defaults match this
# machine's layout.
set -euo pipefail

# --- node / tooling (assumption: the node is already running) -----------------
: "${NET_MAGIC:=1}"   # preprod
: "${CARDANO_NODE_SOCKET_PATH:=/home/logic/Documents/LogicalMechanism/testnets/node-preprod/db-testnet/node.socket}"
: "${NODE_CONFIG:=/home/logic/Documents/LogicalMechanism/testnets/node-preprod/config.json}"
: "${TESTNET_BIN:=/home/logic/Documents/LogicalMechanism/testnets/bin}"
: "${KEYS_DIR:=/home/logic/Documents/LogicalMechanism/testnets/keys}"
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

# --- scripts (settlement is unparameterised; order/pool parameterised by S) ----
export SETTLEMENT_SCRIPT="$SCRIPTS/settlement.plutus"
export ORDER_SCRIPT="$SCRIPTS/order.plutus"
export POOL_SCRIPT="$SCRIPTS/pool.plutus"

# --- identities (derived; see also deployment.json) ---------------------------
export S_HASH="82039119bc85e1b8fb4fab8cfb0628f487e64f0b6338da842950500c"          # settlement (= stake credential S)
export ORDER_HASH="65261b26df3cb88e75bfb936df8d479de2a43e3fef276a1f0e2e4e94"      # order(S)
export POOL_HASH="dfa55af00c04e5ce5d982e7d8e7b991fbc5e96c261f401259ef8b510"       # pool(S)
export S_STAKE_ADDR="$(cat "$SCRIPTS/settlement.stake.addr")"                     # reward account for S
export ORDER_ADDR="$(cat "$SCRIPTS/order.addr")"                                  # where orders live (tagged S)
export POOL_ADDR="$(cat "$SCRIPTS/pool.addr")"                                    # where the pool lives (tagged S)

# --- protocol constants (MUST equal contracts/lib/shaswap/constants.ak) --------
export NFT_NAME="4e4654"            # "NFT"
export LP_NAME="4c50"              # "LP"
export TOTAL_LP="9223372036854775807"
export MIN_LIQ="1000"
export POOL_MIN_ADA="2000000"
export ORDER_MIN_ADA="2000000"

cli() { cardano-cli latest "$@"; }   # cardano-cli 11 groups era subcommands
