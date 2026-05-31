# CLAUDE.md — ShaSwap

Guidance for Claude (and human contributors) working in this repo. This file is
**committed and shared**. Local-only guidance goes in `CLAUDE.local.md` (gitignored).

## What this is

ShaSwap is a fully-decentralized, non-custodial, MEV-resistant **batch-auction DEX
on Cardano (eUTXO)**, built as a hyperstructure. Untrusted solvers compute
uniform-price clearings off-chain; on-chain validators only *verify* them.

## Source of truth — read this first

**[`documentation/BLUEPRINT.md`](documentation/BLUEPRINT.md) is the authoritative
design.** Read it before changing anything. It defines the protocol, the principles,
the settlement rules (§5.2), the threat model (§8), and the open decisions/risks
(§12/§13).

**Never let code and blueprint silently diverge.** If a change alters the design,
update `BLUEPRINT.md` in the same change, bump its `Revision:` line, and note it in
the changelog there. If you discover the blueprint is wrong, fix the blueprint.

## Monorepo layout

| Path | What | Stack |
|---|---|---|
| `documentation/` | Blueprint (source of truth), source papers, specs | Markdown / PDF |
| `contracts/` | On-chain validators & minting policies | **Aiken** (Plutus v3) |
| `batcher/` | Standalone reference solver binary (permissionless role) | **Rust** + **Pallas** |
| `app/` | Website / dApp (wallet, orders, LP, status); hosts the data-access abstraction | **TS + React + MeshJS** |

The components are decoupled. Keep them that way.

## Per-component commands & conventions

### `contracts/` (Aiken)
- Validators in `validators/`, supporting code in `lib/`, env modules in `env/`.
- Build: `aiken build` · Test: `aiken check` (or `aiken check -m <name>`) ·
  Format: `aiken fmt` · Docs: `aiken docs`.
- Plutus v3, `aiken-lang/stdlib`. All arithmetic is integer/rational — no floats.
- The **settlement validator is the immutable trust anchor** and runs once per tx via
  the **withdraw-0** trick (BLUEPRINT §5.4). Pool curves are pluggable *underneath* it.

### `batcher/` (Rust + Pallas)
- A standalone binary; the **reference** solver so the role is genuinely
  permissionless — it is **not** a privileged operator. Anyone may run their own.
- Once scaffolded: `cargo build` · `cargo run` · `cargo test` · `cargo clippy` ·
  `cargo fmt`. Use Pallas (TxPipe) for chain access, tx building, primitives.

### `app/` (TS + React + MeshJS)
- The website; builds order intents and settlements client-side, wallet via MeshJS.
- Once scaffolded: the usual `dev` / `build` / `test` scripts.
- **Hard rule:** all chain data goes through a **data-access abstraction** — no module
  calls a specific provider (Koios/Blockfrost/Maestro) directly, so providers are
  swappable and we can move to our own node (e.g. Dolos) later.

## Inviolable invariants (do not break these without changing the blueprint)

These are distilled from BLUEPRINT §3 (principles) and §5.2 (settlement rules):

- **Decentralization first / hyperstructure:** no admin keys, no governance token, no
  privileged operator, no upgrade authority, **no mortal external dependency in the
  core** (no oracle/indexer/server it can't live without).
- **Non-custodial:** funds are controlled only by the user's key + public validator
  logic. Every well-formed order is reclaimable by its owner on signature.
- **Verify, don't trust:** solvers are untrusted; the chain checks algebra, never
  solves. The settlement validator enforces, once per tx:
  1. **Conservation** — incl. ADA's three roles (tip / min-ADA / traded side) kept
     separate; solver takes **only** posted tips.
  2. **Uniform price** across the batch.
  3. **Pool invariant non-decreasing** (`k` derived from real reserves, **never
     stored**).
  4. **Best-response** per order.
  5. **Per-order floor** — each order gets at least its own limit (never worse than a
     plain AMM).
  6. **No double satisfaction** — injective order→output binding via each order's
     unique `OutputReference` (no per-order NFT).
- **Once-per-tx validator must check EVERY script input** — none may slip past it.
- **Solver reward = ADA tips only.** Never mint a bespoke reward token.
- **Malformed inputs are strictly rejected** — no value path returns `True` for
  unparseable input.
- **Static, low fees in v1.** No oracle in the core (oracle pools, if ever, are
  isolated opt-in fail-safe variants).

## Workflow

- **Commit/push only when asked.** Work on a branch off the default branch; the
  default branch is protected by convention.
- Before deep on-chain implementation, settle the **make-or-break ex-unit spike**
  (BLUEPRINT §13.1): measure real per-order verification cost in a withdraw-0
  settlement validator. That number bounds the whole design.
- When you make or change a decision, update `BLUEPRINT.md` (and bump its Revision)
  and, if it changes project state/next-steps, `MEMORY.md`.

## Local vs shared

- `CLAUDE.md`, `MEMORY.md`, `BLUEPRINT.md` — committed, shared.
- `CLAUDE.local.md` — your personal, machine-local notes (gitignored).
- `.claude/settings.local.json` — local settings/permissions (gitignored).
</content>
