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
      hashes about to ship. Also exercise reclaim, partial fill, LP add/remove, pool create.
- [ ] **Audit current.** [`contracts/audit/audit_report.md`](../../contracts/audit/audit_report.md)
      header pins the audited `BLUEPRINT Rev` and date, and no contract change has landed
      since (else re-audit).

## 1. Deploy the immutable artifacts (mainnet)

Use [`scripts/deploy-mainnet.sh`](../../scripts/deploy-mainnet.sh) (idempotent; prints a
plan and requires explicit confirmation) for the all-in-one run, **or** the human-paced
step scripts in [`scripts/mainnet/`](../../scripts/mainnet/) (`00-verify-build.sh` →
`01-register-s.sh` → `02-deploy-refs.sh` → `03-verify-onchain.sh`) to pause and inspect
between each irreversible step. Both share `scripts/mainnet/lib.sh`, so the same
confirmation-wait + idempotency + verification logic backs either path. They perform,
against mainnet:

- [ ] Apply params and **publish the order + pool reference scripts** (one funding wallet).
- [ ] **Register the settlement staking script `S`** (the withdraw-0 anchor authorizes its
      own registration via the Conway publish handler, BLUEPRINT §5.4).
- [ ] **Verify on-chain == source:** the deployed reference-script hashes equal the
      `plutus.json` hashes, and `S` equals `SETTLEMENT_HASH`.

Record the deploy tx id + output indices (settlement_ref / order_ref / pool_ref).

## 2. Wire the clients to mainnet

- [ ] `app/src/lib/chain/deployment.ts` → `mainnet`: paste `orderRef`/`poolRef`
      (txHash + outputIndex), set `deployed: true`. (`address.test.ts` already pins the
      mainnet addresses.)
- [ ] `.do/app.mainnet.yaml`: set `NEXT_PUBLIC_NETWORK=mainnet`; in the DO console swap
      `BLOCKFROST_PROJECT_ID` to a **mainnet** key (the app refuses to start on a
      key/network prefix mismatch).
- [ ] Batcher `deployment.json` (mainnet): `network_id=1`, `network_magic=764824073`,
      mainnet `kupo_url`/`ogmios_url` (or your own node), the mainnet refs, and a
      mainnet-funded `signing_key_path` (file mode `0600`). See
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
