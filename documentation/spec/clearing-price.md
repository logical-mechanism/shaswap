# Spec stub — Clearing-price representation & rounding (A4 / BLUEPRINT §12.5)

> **Status:** stub. Captures the open questions and the leaning so implementation
> doesn't pick an encoding by accident. To be finalized during the contract deep dive
> and folded back into BLUEPRINT §5.2.2/§5.2.4.

## Why this must be pinned before coding

The clearing price appears in the settlement redeemer and drives the per-order
best-response (§5.2.4) and floor (§5.2.5) checks. Off-chain solve and on-chain verify
must agree **bit-exactly** on every order's fill, or valid settlements get rejected
(liveness) or — worse — rounding slack opens a value leak. Integer/rational only; **no
floats** (Principle 4).

## Representation

- Price as an **exact rational `p = num/den`** (two integers in the redeemer), one
  value for the whole single-shard batch (§5.2.2). Used in the spike.
- `den > 0`; `num ≥ 0`. Decide whether to **require lowest terms** (canonical form) or
  accept any equivalent fraction. *Leaning:* do **not** force lowest terms on-chain
  (gcd is costly); instead bound `num`,`den` and check equivalence where needed via
  cross-multiplication (`a/b ? c/d` ⇒ `a·d ? c·b`), which is what the checks already do.
- Bound `num`,`den` to keep the big-int multiplies in the conservation/k checks within
  the ex-unit budget and to prevent overflow-style griefing.

## Rounding — the decisions to make

For an order selling `s` and receiving `r = s·num/den`:

1. **Direction:** integer **floor** (truncation toward zero, `s*num/den` in Aiken) for
   the amount the trader *receives*. Floor-in-favor-of-the-pool is the conservative
   default — it never pays a trader more than the exact price, so the pool invariant
   and conservation can't be rounded negative. The spike uses floor.
2. **Where rounding lands across roles:** the rounding remainder (the sub-unit dust)
   must be assigned deterministically (to the pool, i.e. kept in reserves) so total
   conservation is exact and ADA's three roles stay separate (§5.2.1).
3. **Floor vs. order limit:** the per-order floor (§5.2.5) is checked on the *rounded*
   `r` (`r ≥ limit`), so a trader is never under-filled by rounding below their own
   stated minimum.
4. **Partial fills:** rounding interacts with the partial-fill remainder split — see
   [`partial-fills.md`](partial-fills.md); the two specs must agree on which side
   absorbs dust.

## Open items

- [ ] Exact `num`/`den` bounds (overflow + ex-unit safety).
- [ ] Canonical-form requirement: yes/no (leaning no).
- [ ] Dust-assignment rule (leaning: to pool reserves).
- [ ] Confirm solver (Rust/Pallas) and validator (Aiken) produce identical integer
      results across the whole range — add a differential test once both exist.
