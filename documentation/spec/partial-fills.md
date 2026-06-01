# Spec stub — Partial-fill semantics (A4 / BLUEPRINT §12.4)

> **Status:** stub. The ex-unit spike filled every order **fully**; partial fills are
> unmeasured and unspecified. They change the settlement validator's output set,
> per-order accounting, and size/cost budget, so they must be pinned before the deep
> dive. Finalize and fold into BLUEPRINT §5.2.4/§7.

## What a partial fill adds

A fully-filled order produces **one** owner-output. A partially-filled order produces
**two** outputs:

1. the **owner-output** for the portion that traded (uniquely bound, §5.2.6), and
2. a **remainder UTXO** — the unfilled portion, re-locked at the order validator so it
   stays a live, reclaimable order (§5.1) for a future settlement.

Both need their own **min-ADA**. So one order-input can require **two** min-ADAs out,
which is the §7 funding problem.

## Decisions to make

1. **Funding the second min-ADA.** Options:
   - **(a) Pre-fund:** the user posts enough ADA at order creation to cover up to `m`
     partial remainders; capped at `m`, after which the order must fill fully or rest.
   - **(b) Cap partials:** allow at most one partial (fill-or-remainder-once), simplest.
   - *Leaning:* **(b) for v1** — one partial max per settlement; revisit (a) later.
2. **`partial` flag semantics.** The `OrderDatum.partial` flag is: `False` =
   all-or-nothing (fill fully or exclude); `True` = may be partially filled down to a
   minimum fill size (define the minimum to avoid dust-spam remainders).
3. **Remainder datum.** The remainder UTXO carries the **same owner/limit/tip-rate**,
   with `sell_amount` reduced by the filled portion. Decide tip handling: does the
   remainder keep a proportional tip, or is the full tip consumed on first fill?
   *Leaning:* tip is **per-fill** and proportional, so a resting remainder still
   incentivizes inclusion.
4. **Rounding interaction.** Filled amount, received amount, and remainder must sum
   **exactly** to the original (conservation, §5.2.1). Dust-assignment must agree with
   [`clearing-price.md`](clearing-price.md).
5. **Binding under partials.** The O(N) positional binding (§5.2.6) must still hold
   with two outputs per partial order — decide the canonical output layout (e.g.
   owner-output then remainder, contiguous per order) so the positional zip stays O(N).
6. **Injectivity.** The remainder is a *new* order UTXO (new OutputReference); ensure
   it cannot be double-counted as both a remainder and an order-output in the same tx.

## Cost note (follow-up measurement)

Each partial adds ~one output + one min-ADA + remainder datum to the tx — raising both
the byte and the memory cost per partially-filled order. The §13.1 sweep should be
re-run with a partial-fill mix to find the realistic cap once semantics are fixed.

## Open items

- [ ] v1 partial policy: confirm (b) one-partial-max.
- [ ] Minimum fill size for `partial = True`.
- [ ] Tip handling on remainder (leaning proportional/per-fill).
- [ ] Canonical output layout for the O(N) binding under partials.
- [ ] Re-measure ex-units with partials.
