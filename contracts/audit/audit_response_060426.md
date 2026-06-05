# Audit Response — `audit_report_060426.md` (audit-machine, 2026-06-04)

Remediation of every finding in the audit-machine report for ShaSwap's on-chain
validators. Worked on branch `contracts/lp-intents`. All fixes are **pre-mainnet**
(`deployed: false`), so re-hashing the affected validators is the correct, expected step
(consistent with the project's prior audit cycles — see BLUEPRINT Rev 14–16).

**Result:** `aiken check -D` → **1637 checks, 0 errors, 0 warnings**; `aiken fmt --check`
clean; `aiken build` reproducible. **152 tests** (137 unit + 15 property), **+16 vs the
audited tree**.

## Validator hash impact (verified against `git HEAD:contracts/plutus.json`)

| Validator | Hash | Reason |
|---|---|---|
| `order` | **unchanged** | `spend.order_*` untouched |
| `lp_intent` | **unchanged** | `lp_intent.ak` logic untouched |
| `settlement` | **CHANGED** | H-01 fix in `clearing.consume_remainder` |
| `pool` | **CHANGED** | M-01/L-02 full-value pin in `spend.lp_action` |
| `pool_mint` | **CHANGED** | L-03 min-ADA check in `mint.create` |

New hashes (`plutus.json`): `settlement 51bfa35d…`, `pool 899b4542…`, `pool_mint
f558dfb2…`. **Downstream propagation required** (see end).

## Finding-by-finding

| ID | Sev | Status | Resolution |
|---|---|---|---|
| **H-01** | High | **Fixed** | `consume_remainder` now `expect ro.pool_nft == order.pool_nft` ([clearing.ak](../lib/shaswap/clearing.ak)), re-binding the partial-fill remainder to the original order's pool — restores the C-02 binding across the rollover. Tests: `partial_remainder_wrong_pool_nft` + `prop_partial_remainder_wrong_pool_nft` (fuzz). |
| **M-01** | Med | **Fixed** | `lp_action` now pins the pool output's full value (`expect out.value == pool_exp`, [spend.ak](../lib/shaswap/spend.ak)), reconstructing it from the input shifted by the reserve/LP deltas — no foreign dust can ride into the shared pool. Tests: `lp_action_foreign_asset_bloat`, `prop_lp_action_reject_foreign_asset`, `lp_action_noop_ok` (no over-rejection). |
| **L-02** | Low | **Fixed** | Same full-value pin holds a token/token pool's overhead lovelace fixed. Test: `lp_action_token_token_lovelace_skim`. |
| **L-03** | Low | **Fixed (on-chain min-ADA) + documented** | `mint.create` now `expect lovelace_of(pool.value) >= pool_min_ada` ([mint.ak](../lib/shaswap/mint.ak)); test `create_below_min_ada`. The address-placement half stays an off-chain-builder responsibility (the policy is seed-only, can't see `S`; one-shot NFT + post-creation continuity make mis-placement a creator self-grief, never third-party theft) — documented in the code + this response. |
| **L-01** | Low | **Documented** | No on-chain creation gate exists for orders/intents (no mint), so the durable fix is builder + docs: a `Script`-owner UTXO is settle-able but never reclaimable. README now states the VK-owner precondition explicitly; `lp_intent_types.ak` already noted "owner = a VK in v1". The off-chain builders must reject non-VK owners. |
| **I-01** | Info | **Fixed** | README `OrderDatum` "8 fields" → "9 fields". |
| **I-02** | Info | **N/A (false positive here)** | The audit ran on a stripped copy lacking `documentation/`. This repo **has** `documentation/BLUEPRINT.md` + `documentation/spec/lp-intents.md`; references resolve. BLUEPRINT bumped to Rev 23 with this remediation logged. |
| **I-03** | Info | **Documented** | Added a doc-comment to `mint.close` explaining the decoupled circulating-LP burn is self-harm-only (dangerous burns are coupled via `pool.ClosePool`). Already pinned by `close_burns_circulating_lp`. |
| **I-04** | Info | **No change (safe as written)** | Existence-based owner bind is injective under the one-intent-per-tx guard; revisit before any batching. |
| **I-05** | Info | **No change (safe as written)** | Pool continuity is pinned transitively by the co-running `LpAction`; `fulfill` already pins the pool value (stricter than the direct path). |
| **I-06** | Info | **Fixed** | `clearing.allow_registration` now unit-tested (accept register / reject unregister+delegate). The real validator entrypoints are driven in new co-located files: [`validators/settlement.test.ak`](../validators/settlement.test.ak) (`publish` certificate authority) and [`validators/pool.test.ak`](../validators/pool.test.ak) (the `LpAction -> !withdrawal_present(S)` wrapper guard + `expect Some(datum)`). Note: the prior "`Never` is impractical to construct" comment was wrong (`Never` is a prelude constructor), and a `.test.ak` file **can** `use` its validator module. |
| **I-07** | Info | **No change (conservative as written)** | `deadline_ok` ignoring `is_inclusive` errs strictly safe. |
| **I-08** | Info | **Fixed** | Added `bench lp_intent__reclaim` ([lp_intent_test.ak](../lib/shaswap/lp_intent_test.ak)); cost is signature-only (action-independent), so one bench covers withdraw+deposit reclaim — completing per-redeemer bench coverage. |
| **O-01** | Opt | **Deferred** | `assets.tokens` vs `flatten(restricted_to())` — cold path, negligible saving; deferred to an optimization pass to keep this diff correctness-only. |
| **O-02 / O-03** | Opt | **Deferred** | Fold-fusion of the multi-pass traversals in `clearing.run` / `lp_intent.fulfill` — the audit itself rates these Low–Medium risk ("must not alter binding"); deferred with before/after benches rather than risk the hot-path binding logic in a security-remediation change. |

## Required downstream follow-up (out of scope for the contract fixes)

The `settlement` / `pool` / `pool_mint` hashes changed, so any **existing preprod
deployment runs the old code** and these files pin **stale** hashes — they must be
regenerated from the new `plutus.json` after a fresh testnet redeploy:

- `app/src/lib/chain/deployment.ts`
- `batcher/config/deployment.mainnet.example.json`, `batcher/crates/chain/tests/fixtures/kupo-patterns.json`
- `scripts/mainnet/lib.sh`
- `contracts/happy_path/{env.sh,deployment.json}` (real preprod refs — regenerate by redeploying, do not hand-edit)
- `documentation/prompts/create-pool-integration.md`, repo-root `MEMORY.md`

These were intentionally **not** auto-edited: the values are tied to on-chain
deployments and must come from an actual redeploy, not be fabricated.
