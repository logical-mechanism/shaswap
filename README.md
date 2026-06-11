# ShaSwap

A fully-decentralized, non-custodial, MEV-resistant **batch-auction DEX on Cardano
(eUTXO)**, built as a **hyperstructure**: no admin keys, no governance token, no
privileged operator, no upgrade authority. Untrusted solvers compute uniform-price
clearings off-chain; the on-chain validators only *verify* them.

> **Design source of truth:** [`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md).
> Read it before changing anything. It defines the protocol, the principles, the
> settlement rules (§5.2), the threat model (§8), and the open decisions/risks (§12/§13).

## Network status

| Network | Contracts live | dApp |
|---|---|---|
| **mainnet** | ✅ deployed (2026-06-08) | `NEXT_PUBLIC_NETWORK=mainnet` — **live at app.shaswap.org** |
| **preprod** | ✅ deployed | `NEXT_PUBLIC_NETWORK=preprod` (testnet rehearsal) |

ShaSwap's immutable validators are **live on mainnet** as of 2026-06-08 (deploy tx
`d56e729ca24c10188d27023e9c80d681a6e9705220188bfed618b869096087cb`). The order and
`lp_intent` reference scripts still live in that tx; the pool ref was re-published by the
H-01 fork (tx `bfce12e4…#0`, Rev 29) and the settlement ref republished on 2026-06-11
(tx `8d788d74…#0`). The deploy/verify procedure that produced them is in
[`documentation/launch/mainnet-checklist.md`](documentation/launch/mainnet-checklist.md).

## Monorepo layout

| Path | What | Stack |
|---|---|---|
| [`documentation/`](documentation/) | Blueprint (source of truth), source papers, specs | Markdown / PDF |
| [`contracts/`](contracts/) | On-chain validators & minting policies | **Aiken** (Plutus v3) |
| [`batcher/`](batcher/) | Standalone reference solver binary (permissionless role) | **Rust** + **Pallas** |
| [`app/`](app/) | Website / dApp (wallet, orders, LP, status) | **TS + React + MeshJS** |

The components are decoupled and kept that way. Each has its own README:
[contracts](contracts/README.md) · [batcher](batcher/README.md) · [app](app/README.md).

## Build & test per component

```sh
# Contracts (Aiken / Plutus v3)
cd contracts && aiken fmt --check && aiken check && aiken build

# Batcher (Rust reference solver)
cd batcher && cargo fmt --check && cargo clippy && cargo test

# App (Next.js dApp) — Node 22.6+
cd app && npm ci && npm run lint && npx tsc --noEmit && npm test && npm run build
```

## Verifying the on-chain artifacts (reproducible build)

The validators are **immutable** once deployed, so the trust chain from audited source
to on-chain hash must be independently reproducible. The compiler is pinned to the exact
build recorded in [`contracts/plutus.json`](contracts/plutus.json) (`compiler.version`),
and CI fails if a fresh `aiken build` would change the committed `plutus.json`:

```sh
cd contracts
aiken build                       # regenerates plutus.json from source
git diff --exit-code plutus.json  # must be clean — byte-identical to what's committed
```

Anyone deploying or auditing can re-derive the script hashes this way and compare them
against what is registered on-chain.

## Running a solver

The batcher is a **permissionless, unprivileged** role — anyone may run their own and it
earns only the ADA tips posted on orders. See [`batcher/README.md`](batcher/README.md)
for setup, and [`documentation/launch/batcher-operations.md`](documentation/launch/batcher-operations.md)
for the operator runbook (config, monitoring, recovery).

## Key documents

- [`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md) — authoritative design (start here)
- [`CLAUDE.md`](CLAUDE.md) — contributor guidance & inviolable invariants
- [`contracts/audit/audit_report.md`](contracts/audit/audit_report.md) — contract audit
- [`documentation/README.md`](documentation/README.md) — index of specs & papers

## License

[Apache-2.0](LICENSE) — see also [`NOTICE`](NOTICE).
