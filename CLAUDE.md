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
- The deployment set is `settlement`, `order`, `pool`, `pool_mint`, and `lp_intent`
  (a **second immutable validator** — batcher-fulfilled LP deposits/withdrawals,
  BLUEPRINT §5.1/§5.4; `Fulfill` is self-contained, `ReclaimLp` is owner-signature-only).
  It joins as a NEW hash; the other four hashes are unchanged.

### `batcher/` (Rust + Pallas)
- A standalone binary; the **reference** solver so the role is genuinely
  permissionless — it is **not** a privileged operator. Anyone may run their own.
- Implemented as a Cargo workspace (`crates/`): `cargo build` · `cargo run` ·
  `cargo test` · `cargo clippy` · `cargo fmt`. Use Pallas (TxPipe) for chain access,
  tx building, primitives.

### `app/` (TS + React + MeshJS)
- The website; builds order intents and settlements client-side, wallet via MeshJS.
- Next.js (Node `>=22.6`): `npm run dev` · `npm run build` · `npm run lint` ·
  `npm test` (node `--test` strip-types runner over `src/**/*.test.ts`) ·
  `npm run test:components` (vitest) · `npm run e2e` (playwright).
- **Hard rule:** all chain data goes through a **data-access abstraction** — no module
  calls a specific provider (Koios/Blockfrost/Maestro) directly, so providers are
  swappable and we can move to our own node (e.g. Dolos) later.
- **Network is one knob** (`NEXT_PUBLIC_NETWORK` → `APP_CONFIG.network`): the same build
  serves preprod/preview/mainnet. Per-network identities live in
  `src/lib/chain/deployment.ts`; everything network-independent (script hashes, compiled
  code, constants) is shared. Mainnet is live (`deployed: true`, since 2026-06-08); preview is
  the only network not deployed.
- **Deploy:** DigitalOcean App Platform (Node buildpack, auto-deploy on push); one app per
  network — specs in `.do/`. `NEXT_PUBLIC_*` must be `RUN_AND_BUILD_TIME` (build-inlined);
  the Blockfrost key is a `RUN_TIME` secret whose prefix must match the network.

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
     plain AMM). The clearing price is **pinned two-sided** (BLUEPRINT Rev 25) so the
     solver cannot harvest the floor→fair corridor.
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
  and, if it changes project state/next-steps, your local `MEMORY.md`.

## Local vs shared

- `CLAUDE.md`, `BLUEPRINT.md` — committed, shared.
- `CLAUDE.local.md`, `MEMORY.md` — personal, machine-local notes (gitignored).
- `.claude/settings.local.json` — local settings/permissions (gitignored).
</content>
