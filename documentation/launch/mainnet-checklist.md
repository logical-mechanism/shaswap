# Mainnet launch checklist

> The go-live gate for ShaSwap mainnet. Because the validators are **immutable**, this is
> a one-shot, no-take-backs deployment: the same byte-identical artifacts that pass the
> gates below are the ones promoted to mainnet. Do not skip a gate.

## 0. Pre-flight gates (must all be green on the FROZEN release candidate)

- [ ] **Reproducible build.** `cd contracts && aiken build && git diff --exit-code plutus.json`
      is clean with the pinned compiler (`plutus.json` `compiler.version`). CI enforces this.
- [ ] **Full-tx ex-unit confirmation.** An emulator / real Plutus evaluator run of
      1..N-order settlements with a real CBOR `ScriptContext` confirms the ~40–50 order
      ceiling holds (typed-value tests under-count decoding — BLUEPRINT §13.1 caveat).
- [ ] **End-to-end on preprod, byte-identical artifacts.** A real CIP-30 in-browser order
      post → reference batcher settles → owner receives payout, against the exact script
      hashes about to ship. Also exercise reclaim, partial fill, LP add/remove, pool create,
      and the **LP-intent path** (§5.1 Rev 22): on a continuously-settled pool, post a
      withdraw/deposit intent and confirm the batcher fulfils it **within a block** alongside
      swap settlements (the whole point); confirm the direct `LpAction` path still works on a
      quiet pool; confirm LP-intent reclaim (a withdraw reclaim returns LP tokens, §13.11).
- [ ] **Clearing-price pin (Rev 25) in the frozen set.** The two-sided pool price pin
      (`spend.pool_settle`) + the `lp_intent` exact-proportional pin are part of the immutable
      deployment — **`pool` and `lp_intent` carry NEW hashes.** The **deployed (`S`-applied)**
      hashes on preprod are `pool 34b30c7a…` and `lp_intent fa885b03…`; the **unapplied
      (parameterised)** forms in `plutus.json` are `07332aa6…`/`05451fe2…` (applying `S` yields
      the deployed forms — do **not** confuse the two). Regenerate the applied hashes at the
      mainnet RC. `settlement`/`S` (`a305a3cf…`), `order` (`e7fa1a38…` applied), and `pool_mint`
      stay byte-identical (verify via the reproducible-build diff **and** the deploy's on-chain
      hash gate, which re-hashes each published `.plutus` against these applied values). Spec:
      [`spec/clearing-price-pin.md`](../spec/clearing-price-pin.md).
- [ ] **Corridor-fix E2E on preprod.** Confirm: a one-sided / market-limit order settles at
      the **fair AMM-curve price** (≈ `get_amount_out`, not the order floor); an attempted
      underpayment beyond the `n_orders` dust band is **rejected on-chain**; the reference
      batcher's fair-equilibrium pricing fulfils one-sided books **within a block** (no
      liveness regression). Re-run the differential parity (`prop_pin_fair_boundary` /
      `pin_ok_boundary_matches_contract`) against the frozen artifacts.
- [ ] **Ex-unit headroom for the pin.** The §13.1 full-tx run confirms the (O(1)) pin +
      `get_amount_out` per pool-spend does not lower the ~40–50 order ceiling.
      **Scope B — DECIDED (Rev 26): not shipped.** The perfectly-netted zero-residual
      trader↔trader split is **accepted as a documented Scope A residue** (a bounded
      trader↔trader transfer, pool untouched so no solver-LP harvest; closing it would change
      `S` → re-audit the anchor + lower `N` — disproportionate). App-side mitigation (tight
      default limits, never a true market order) stands. `lp_intent` being non-frozen does NOT
      extend to `S`.
- [ ] **Audit current.** [`contracts/audit/audit_report.md`](../../contracts/audit/audit_report.md)
      header pins the audited `BLUEPRINT Rev` (**Rev 25**) and date, and no contract change has
      landed since (else re-audit). **Rev 26 is a docs-only Scope B decision — no contract
      change — so the Rev 25 audit remains current.** The Rev 25 pin is **new value-protecting
      code outside the audited anchor** — it must be in the audited scope before mainnet.

## 1. Deploy the immutable artifacts (mainnet)

Use [`scripts/deploy-mainnet.sh`](../../scripts/deploy-mainnet.sh) (idempotent; prints a
plan and requires explicit confirmation) for the all-in-one run, **or** the human-paced
step scripts in [`scripts/mainnet/`](../../scripts/mainnet/) (`00-verify-build.sh` →
`01-register-s.sh` → `02-deploy-refs.sh` → `03-verify-onchain.sh`) to pause and inspect
between each irreversible step. Both share `scripts/mainnet/lib.sh`, so the same
confirmation-wait + idempotency + verification logic backs either path. They perform,
against mainnet:

- [ ] Apply params and **publish the order, pool, and `lp_intent` reference scripts** (one
      funding wallet). `lp_intent` is the fifth, additive immutable hash (Rev 22, `S`-applied
      like order/pool); the dApp spends it on the `ReclaimLp` path via this reference script.
- [ ] **Register the settlement staking script `S`** (the withdraw-0 anchor authorizes its
      own registration via the Conway publish handler, BLUEPRINT §5.4).
- [ ] **Verify on-chain == source:** the deployed reference-script hashes equal the
      `plutus.json` hashes (incl. `lp_intent`), and `S` equals `SETTLEMENT_HASH`.

Record the deploy tx id + output indices (settlement_ref / order_ref / pool_ref /
lp_intent_ref).

## 2. Wire the clients to mainnet

- [ ] `app/src/lib/chain/deployment.ts` → `mainnet`: paste `orderRef`/`poolRef`/`lpIntentRef`
      (txHash + outputIndex), set `deployed: true`. Pasting a non-null `lpIntentRef` flips
      `LP_INTENTS_LIVE` true (the batcher LP path goes live). The `lp_intent` hash + enterprise
      address are **derived** from `SETTLEMENT_HASH` (`lpIntentScript.ts`) — update the
      `lpIntentScript.test.ts` golden to the mainnet-`S` values (as `address.test.ts` pins the
      order/pool addresses). No hand-fabricated refs — take them from the verified deploy tx.
- [ ] `.do/app.mainnet.yaml`: set `NEXT_PUBLIC_NETWORK=mainnet`; in the DO console swap
      `BLOCKFROST_PROJECT_ID` to a **mainnet** key (the app refuses to start on a
      key/network prefix mismatch).
- [ ] Batcher `deployment.json` (mainnet): `network_id=1`, `network_magic=764824073`,
      mainnet `kupo_url`/`ogmios_url` (or your own node), the mainnet refs (incl.
      `lp_intent_ref`), and a mainnet-funded `signing_key_path` (file mode `0600`). Ensure the
      indexer covers the **`lp_intent` address** so the batcher discovers + chains LP-intent
      fulfillments into its per-block pool-spend sequence. See
      [`batcher-operations.md`](batcher-operations.md).

## 3. Bootstrap liquidity

- [ ] Create the canonical launch pools and make their first deposits (clearing the
      first-deposit math), per [`../spec/liquidity-bootstrap.md`](../spec/liquidity-bootstrap.md).
- [ ] Add them to `app/src/lib/chain/verifiedPools.ts` so the dApp badges them.

## 4. Go live

- [ ] Start **≥2 independent** reference batchers (different hosts/regions) for liveness
      defense-in-depth.
- [ ] Mainnet wallet smoke test across Eternl / Nami / Lace / Flint: connect → post →
      settle → reclaim.
- [ ] Announce; publish the deployed script hashes + verified-pool set for independent
      verification.

## 5. Post-launch

- [ ] Monitor per [`batcher-operations.md`](batcher-operations.md) (settlement success,
      funding, collateral, P&L).
- [ ] Bump `BLUEPRINT.md` `Revision:` with a changelog entry recording the mainnet
      deployment (hashes, refs, date).
