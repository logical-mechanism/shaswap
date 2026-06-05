# Batcher operations runbook

> How to run a ShaSwap reference solver as an unattended mainnet service: config,
> monitoring, alerts, recovery, and key management. The batcher is **permissionless and
> unprivileged** — it earns only posted ADA tips and has no special authority. Anyone may
> run one. See also [`../../batcher/README.md`](../../batcher/README.md) for the binary's
> CLI and internals.

## Configuration

The batcher reads a `deployment.json` (path via `SHASWAP_DEPLOYMENT`). For mainnet, base
it on [`../../batcher/config/deployment.mainnet.example.json`](../../batcher/config/deployment.mainnet.example.json):

- `network_id: 1`, `network_magic: 764824073` (mainnet). **Preprod is `0` / `1`** — the
  startup banner prints the resolved network; confirm it before setting `SHASWAP_SUBMIT=1`.
- `kupo_url` / `ogmios_url`: your mainnet Kupo + Ogmios (self-hosted node strongly
  preferred for a no-third-party-dependency setup — see [`../spec/data-availability.md`](../spec/data-availability.md)).
- `settlement_hash` / `order_script_hash` / `pool_script_hash` / refs: the **mainnet**
  deploy values (must match `plutus.json` and the dApp's `deployment.ts`).
- `signing_key_path`: a cardano-cli TextEnvelope `.skey` for the solver wallet. **File
  mode `0600`, never committed.** Fund this address with ADA; the batcher self-manages its
  UTXOs (funding change + a one-time auto-provisioned collateral UTXO).
- `max_orders_per_tx`: keep at/below the measured ceiling (default 20; ~40–50 is the
  ex-unit limit — see [`../spec/ex-unit-spike.md`](../spec/ex-unit-spike.md)).

Runtime env: `SHASWAP_SUBMIT=1` (actually submit), `SHASWAP_INTERVAL_MS` (daemon poll
cadence), `SHASWAP_STRATEGY` (`round-robin` | `profit-greedy`), `RUST_LOG`.

## systemd service

```ini
# /etc/systemd/system/shaswap-batcher.service
[Unit]
Description=ShaSwap reference solver
After=network-online.target
Wants=network-online.target

[Service]
User=shaswap
WorkingDirectory=/opt/shaswap/batcher
Environment=SHASWAP_DEPLOYMENT=/opt/shaswap/config/deployment.mainnet.json
Environment=SHASWAP_SUBMIT=1
Environment=SHASWAP_INTERVAL_MS=500
Environment=SHASWAP_STRATEGY=round-robin
Environment=RUST_LOG=info
ExecStart=/opt/shaswap/batcher/target/release/shaswap-batcher
Restart=always
RestartSec=5
# SIGTERM is handled cleanly *between passes* (never mid-submit), so a restart is safe.
KillSignal=SIGTERM
TimeoutStopSec=60
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/shaswap/config

[Install]
WantedBy=multi-user.target
```

Ship logs to your aggregator (journald → Loki/ELK); `RUST_LOG=info` is structured tracing
with timestamps and levels. Each pass logs a running wallet-balance P&L
(`balance_ada` + `delta_ada` since start).

## Monitoring & alerts

The binary emits structured logs today (no metrics endpoint yet — Prometheus/OTel export
is a tracked post-launch enhancement). Until then, derive alerts from the log stream:

| Condition | Signal in logs | Alert |
|---|---|---|
| Settlement failures | repeated `EvaluateTx` rejects / submit errors | page if sustained > a few passes |
| Funding depleted | `balance_ada` trending to ~0; "insufficient funding" | top up the solver address |
| Collateral lost | collateral-provisioning re-runs / collateral-missing errors | investigate; ensure ≥2 UTXOs |
| Backend down | Kupo/Ogmios connection errors; passes aborting | restore the node/index |
| Stalled book | passes run but settle 0 while orders rest | check competing solvers / cadence |
| Negative P&L drift | `delta_ada` persistently negative | review tip economics / `max_orders_per_tx` |

For **liveness defense-in-depth**, run **≥2 independent batchers** on different
hosts/regions so one outage doesn't stall the book. They compete safely: every tx is
`EvaluateTx`-gated and first-valid-wins; a loser simply rebuilds next pass.

## Recovery playbooks

- **Restart:** `systemctl restart shaswap-batcher`. Safe at any time — shutdown is
  between-pass; collateral is never consumed on success.
- **Funding top-up:** send ADA to the solver address; no restart needed (next pass picks
  it up). Funding is drawn only from ada-only UTXOs (dust/token-poisoning guard).
- **Wrong network:** the startup banner names the network; if it says the wrong one, stop,
  fix `deployment.json` (`network_id`/`network_magic`/refs), restart.
- **Key rotation:** stop the service, drain the old solver wallet, point
  `signing_key_path` at the new `.skey`, fund it, restart. No on-chain registration is
  tied to the solver key (the role is permissionless).

## Key management

- The solver `.skey` controls only the **solver's own funds** (its tips and working
  capital) — never user funds. Compromise costs the operator their float, not users.
- Store it `0600`, off the repo, ideally on the host only (or a secrets manager). Back up
  enough to recover the float; rotate as above if exposed.
