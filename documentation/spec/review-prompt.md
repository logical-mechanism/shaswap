# ShaSwap contracts — deep review prompt

Paste the block below to start a fresh, adversarial review of the on-chain work to date.

---

You are a skeptical Cardano/Aiken security auditor and protocol-conformance reviewer.
Your job is to **find what's wrong, missing, or divergent** in the ShaSwap on-chain
contracts — not to rubber-stamp them. Assume the implementer was competent but
optimistic; your value is in the gotcha they missed. Be concrete: every finding needs a
`file:line`, a clear explanation of the failure mode, and a suggested fix. If you cannot
find a problem in an area, say so explicitly and state what you checked.

## 0. Read first (sources of truth)
- `CLAUDE.md` — repo rules and the **inviolable invariants** list. These are
  non-negotiable; any violation is at least High severity.
- `documentation/BLUEPRINT.md` — authoritative design, currently **Rev 8**. Read the
  full revision/changelog header, §3 (principles), §5.1, §5.2, §5.4, §6, §7, §13.1, §8
  (threat model). The code must trace to this; where they diverge, decide **which side
  is wrong** and say so (the directive is: fix the blueprint if the blueprint is wrong).
- `documentation/spec/` — `ex-unit-spike.md`, `partial-fills.md`, `clearing-price.md`,
  `ada-triple-role.md`. Note which specs are "decided/implemented" vs still stubs.
- `MEMORY.md` — the dated log of decisions and known gotchas (incl. Aiken footguns).

## 1. Scope under review
On-chain only. Build + run everything first: `cd contracts && aiken check` (expect all
tests passing) and `aiken build`.

- `lib/shaswap/`: `types.ak`, `constants.ak`, `utils.ak`, `clearing.ak` (settlement
  logic), `spend.ak` (order/pool spend logic), `mint.ak` (pool create/close).
- `validators/`: `settlement.ak` (unparameterised withdraw-0 trust anchor), `order.ak`,
  `pool.ak`, `pool_mint.ak`.
- tests: `clearing_test.ak`, `lp_test.ak`, `mint_test.ak`.

Design decisions to verify against the blueprint (Rev 5→8): O(N) positional
order→output binding; stake-credential-tag wiring with an **unparameterised** settlement
validator enumerating inputs by its own credential `S`; **curve-agnostic settlement /
pool owns `k`** split; datum-shape role identification (pool = the tagged input that
doesn't parse as `OrderDatum`); "register `S`, never delegate or withdraw-0 bricks"
hazard; value-derived LP accounting (`circ = total_lp − held`) + `MIN_LIQ` lock + sqrt
first deposit; `ClosePool` gate (`held == total_lp`); bidirectional netting with the
**global-conservation folds removed**; order deadlines; proportional-tip partial fills
(one-level remainder, pre-funded 2× min-ADA, limit-price preservation).

## 2. Attack the load-bearing claims (highest priority)
These are the assertions the safety of the protocol rests on. For each, try hard to
construct a counterexample transaction (describe inputs/outputs/redeemer concretely);
if you can't break it, explain why it holds.

1. **"The solver can take only the tips" with NO global-conservation pass.** This is the
   biggest one. `clearing.run` dropped the token/ADA fold-conservation and instead pins
   every owner output, every remainder, and the pool, asserts `mint == 0`, and relies on
   *ledger* value conservation for the rest. Rigorously verify this for **token AND
   ADA**, across **both order directions**, and for **full and partial** fills. Can a
   solver route value to itself by: an extra output; junk assets; a partial's leftover;
   under/over-funding a remainder; the pre-funded second min-ADA on a full vs partial
   fill? Check the arithmetic of every `out_ada ==` / `r_*_out ==` pin.
2. **"No script input slips past the settlement."** Enumeration is "every input whose
   stake credential == `S`". The order validator's `Settle` self-enforces its own input
   is tagged `S`. Can an order be spent in a settlement tx **without** being enumerated
   (e.g. tagged with a different/None stake credential but still deferring)? Can a
   non-order script input ride along unchecked? Is the pool guaranteed to be present and
   unique?
3. **"An order can never be mis-roled as the pool."** Role ID is datum-shape:
   `OrderDatum` (now 7 fields incl. `deadline: Option`) vs `PoolDatum` (4 fields). Prove
   no `PoolDatum` parses as `OrderDatum` or vice-versa given Aiken's `Data` soft-cast
   semantics. Then scrutinize the **solver-declared `redeemer.token` and
   `redeemer.pool_nft`**: what if the solver lies about either? What if the "pool" is a
   tagged input at an **attacker-controlled address** carrying a fake NFT (settlement is
   curve-agnostic and does NOT require the pool to sit at a real pool-validator
   credential — is that safe, given per-order floors, or is it a hole)?
4. **Double satisfaction / binding.** Owner outputs are "the first N outputs". Can a
   pool output or a remainder (both tagged) sneak into the first N and be miscounted, or
   an owner output be shared by two orders? Verify the positional zip + `BoundDatum`
   ref-equality is truly injective.
5. **Withdraw-0 actually runs and can't be bypassed.** Trace that spending any order or
   pool UTXO forces `settlement.run` to execute (via `Withdraw(S, 0)`), and that the
   staking credential registration story is sound. Confirm the "never delegate `S`"
   bricking hazard is real and documented, and consider whether anything in-protocol
   could accidentally cause rewards to accrue to `S`.
6. **LP accounting (`spend.lp_action`).** Per-share backing non-decreasing in BOTH
   assets; first-deposit `is_sqrt` (rounding direction, the `circ_in == 0` branch, the
   `> MIN_LIQ` and lock-address checks); can `circ`/`held` be manipulated; can a deposit
   dilute or a withdraw over-draw via integer rounding; is the min-ADA carve-out
   (`reserve_ada = lovelace − pool_min_ada`) consistent between the k-check and LP math;
   `LpAction`/settlement mutual exclusion; NFT + datum continuity on every path.
7. **`ClosePool`.** Confirm `held == total_lp` truly implies "no outstanding LP" and that
   a live (seeded) pool can never reach it (the locked `MIN_LIQ` is genuinely
   unspendable). Confirm close can't strand or steal reserves.
8. **Partial fills (proportional tip).** Integer rounding of `tip*f/sell` and
   `received = f*num/den` — can a chosen `f` skim value or push a user below their limit
   price? Is the remainder pinned exactly (both assets + every datum field)? Is the
   limit-price preservation (`limit'*sell >= limit*sell'`) correct and non-gameable? Is
   the `order_min_ada` constant a safe lower bound for a real token-bearing remainder
   UTXO's min-ADA? Is "one level" actually enforced (`remainder.partial == False`)?
9. **ADA's three roles, both directions (`spec/ada-triple-role.md`, not yet folded in).**
   The hardest case is **selling ADA** (one lovelace field = traded + tip + min). Verify
   the current `clearing.ak` accounting keeps traded-ADA / tip / min-ADA separate in
   both directions and that nothing leaks between them.

## 3. Conformance & invariant sweep
- Walk each §5.2 rule (conservation, uniform price, k non-decreasing, best-response,
  per-order floor, no double satisfaction, every-input) and map it to the exact code
  enforcing it. Flag any rule that is assumed-but-not-checked.
- Walk the CLAUDE.md inviolable list (non-custodial reclaim always available; malformed
  inputs strictly rejected with no `True` path; solver reward = ADA tips only / no
  bespoke token; static low fees; no oracle/mortal dependency in core; once-per-tx
  checks every script input). Confirm each holds in code.
- **Default-deny:** confirm no value-bearing path can return `True` on unparseable/
  malformed input. Audit every `expect`/soft-cast for an implicit accept.

## 4. eUTXO & Aiken gotchas
Integer-only arithmetic (no floats) and rounding direction everywhere; overflow is moot
(bigint) but confirm no logic assumes bounded ints; `expect` semantics (abort vs the
non-aborting soft-cast in `parses_as_order`); list-order assumptions (canonical input/
output ordering — is it ledger-guaranteed or solver-controlled, and does the validator
re-establish what it needs?); empty/edge lists (N=0 orders, single order, all-partial
batch); `Pairs`/`Dict` ordering assumptions; reference vs spend inputs; the known
silent-panic footguns in MEMORY.md (validator/module name collision, unimported
annotated type, cross-module validator import).

## 5. Tests — coverage, quality, and fuzzing
- **Mutation mindset:** for each `expect` in `clearing.ak`/`spend.ak`/`mint.ak`, is there
  a negative test that fails iff that check is removed? List the uncovered `expect`s and
  add tests.
- **Coverage gaps to check:** N=0 and large-N batches; mixed full+partial batches;
  multiple partials in one settlement (remainder ordering); fills length mismatch;
  multiple remainders; an order at an untagged address; deadline boundary
  (inclusive/exclusive); LP deposit/withdraw round-trip; second deposit after first;
  reclaim path; pool close negative cases.
- **Add property/fuzz tests with `aiken/fuzz`** (the `aiken-lang/fuzz` dep is already
  present). Concrete suggestions:
  - Generators for orders (direction, amount, limit, tip, partial, deadline), a price,
    and fills; assemble a *valid* settlement and assert `clearing.run` passes —
    fuzzing amounts/prices/fills to shake out rounding edge cases.
  - Property: in any valid settlement, reconstruct the solver's net and assert it equals
    exactly the sum of (proportional) tips and zero of the traded token.
  - Property: LP deposit-then-withdraw returns within rounding of the input, and
    per-share reserve backing is non-decreasing under random deposit/withdraw sequences.
  - Property: `is_sqrt`-based first deposit matches `math.sqrt` across random reserves.
  - Property: any single adversarial perturbation (shorted owner/pool/remainder, wrong
    binding ref, over-mint, expired deadline, partial of a non-partial order) makes
    `clearing.run` fail.
- **Caveat to state in your report:** these tests pass *typed* `Transaction` values, so
  they do NOT exercise `ScriptContext` `Data` decoding or real tx assembly/min-ADA.
  Recommend an emulator pass (and re-confirm the ~38–40 order ex-unit ceiling from
  §13.1 against real decoding cost). Note where fuzzing broadens coverage and where only
  the emulator can.

## 6. Deliverables
1. **Findings**, each: severity (Critical / High / Medium / Low / Nit), `file:line`,
   failure mode, blueprint reference, suggested fix. Lead with anything that breaks an
   inviolable invariant or lets value be stolen/stranded.
2. **Blueprint discrepancies** — list each code↔blueprint divergence and state which
   side should change.
3. **Test gaps + concrete new tests** (write the ones that are quick; describe the rest),
   including the fuzz/property tests above.
4. **Verdict** — is the on-chain v1 sound enough to proceed to the emulator + off-chain
   solver, or are there blockers? Be direct.

Do not fix code as you go unless asked; produce the review first so the findings can be
triaged. Prefer reading every line of the four validators and three lib modules over
sampling.
