# Batcher operations runbook

> How to run a ShaSwap reference solver as an unattended mainnet service: config,
> monitoring, alerts, recovery, and key management. The batcher is **permissionless and
> unprivileged** — it earns only posted ADA tips and has no special authority. Anyone may
> run one. See also [`../../batcher/README.md`](../../batcher/README.md) for the binary's
> CLI and internals.

## Configuration

The batcher reads a `deployment.json` (path via `SHASWAP_DEPLOYMENT`). For mainnet, base
it on [`../../batcher/config/deployment.mainnet.example.json`](../../batcher/config/deployment.mainnet.example.json).
It carries only network + endpoints + the immutable script hashes/refs + your solver key —
**no per-pool or per-token config**: the batcher discovers *every* pool dynamically (each pool
self-describes via its `PoolDatum`), so a single batcher serves all pools.

- `network_id: 1`, `network_magic: 764824073` (mainnet). **Preprod is `0` / `1`** — the
  startup banner prints the resolved network; confirm it before setting `SHASWAP_SUBMIT=1`.
- `kupo_url` / `ogmios_url`: your mainnet Kupo + Ogmios (self-hosted node strongly
  preferred for a no-third-party-dependency setup — see [`../spec/data-availability.md`](../spec/data-availability.md)).
  **Kupo must index the `lp_intent` enterprise address** (it is NOT `S`-tagged, so a pattern
  matching only the `S` stake credential misses it) or the batcher never sees LP intents.
- `settlement_hash` / `order_script_hash` / `pool_script_hash` / `lp_intent_script_hash` and
  the refs (`settlement_ref` #0, `pool_ref` #1, `order_ref` #2, `lp_intent_ref` #3): the
  **mainnet** deploy values (must match `plutus.json` and the dApp's `deployment.ts`).
  `lp_intent_ref` is optional — omit it to run settlements-only (LP fulfillment off).
- `signing_key_path`: a cardano-cli TextEnvelope `.skey` for the solver wallet. **File
  mode `0600`, never committed.** Fund this address with ADA; the batcher self-manages its
  UTXOs (funding change + a one-time auto-provisioned collateral UTXO).
- `max_orders_per_tx`: keep at/below the measured ceiling (code default 20). The
  **confirmed safe cap is 30** — a real 30-order settlement settles *well within* budget
  on preprod (the full-tx run in [`mainnet-checklist.md`](mainnet-checklist.md) §0). Treat
  the typed-value spike's ~40–50 as a theoretical projection that **over-counts** real
  headroom (it omits `ScriptContext` decoding); the true full-tx ceiling sits just above
  30, so 30 is the cap to run at — see [`../spec/ex-unit-spike.md`](../spec/ex-unit-spike.md).

Runtime env: `SHASWAP_SUBMIT=1` (actually submit), `SHASWAP_INTERVAL_MS` (daemon poll
cadence), `SHASWAP_STRATEGY` (`round-robin` | `profit-greedy`), `SHASWAP_METRICS_ADDR` /
`SHASWAP_HEALTH_ADDR` (expose Prometheus `/metrics` + `/health`,`/ready` — see
[Monitoring & alerts](#monitoring--alerts)), `RUST_LOG`.

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
Environment=SHASWAP_METRICS_ADDR=127.0.0.1:9100
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

Set `SHASWAP_METRICS_ADDR=127.0.0.1:9100` to expose a Prometheus endpoint (`GET /metrics`)
plus `GET /health` (liveness) and `GET /ready` (returns `503` until a pass has completed
within ~90 s — a *hung*-daemon signal a crash-only `Restart=always` never catches; wire it
to a systemd/k8s watchdog). It is a std-only HTTP server with no effect on the settle loop;
bind it to localhost or a private network. Key series:

| Metric | Use |
|---|---|
| `shaswap_last_pass_unixtime`, `shaswap_passes_total` | liveness — alert if it stops advancing (or use `/ready`) |
| `shaswap_settlements_total`, `shaswap_orders_settled_total`, `shaswap_lp_fulfillments_total` | throughput |
| `shaswap_pnl_lovelace`, `shaswap_fees_lovelace_total`, `shaswap_tips_taken_lovelace_total` | economics — alert on a sustained P&L drawdown |
| `shaswap_wallet_balance_lovelace` | funding — alert before it nears `collateral + one fee` |
| `shaswap_submit_failures_total`, `shaswap_pass_failures_total`, `shaswap_backend_errors_total` | error rates — alert on a rising slope |
| `shaswap_reorgs_total` | rollbacks (rare; a spike is worth a look) |
| `shaswap_pending_count`, `shaswap_pools_active`, `shaswap_orders_resting` | book / in-flight depth |

Without a scraper, the **structured logs carry the same signals** (most failure lines now
carry a `category=` field — `transient` / `config` / `data` / `critical`):

| Condition | Signal in logs | Alert |
|---|---|---|
| Config / critical error | a failure line tagged `category=critical` or `category=config` | page (deploy / contract / endpoint problem) |
| Script-validation failure | `assemble [...]` / `submit [...]` containing `SCRIPT VALIDATION failure` | **page** — a gated tx must never fail validation (contract/constant drift) |
| UTXO race / ex-unit limit | `[utxo race ...]` / `[ex-unit/size limit ...]` on a skipped pool | normal under competition / lower `SHASWAP_MAX_ORDERS_PER_TX` |
| Backend down | `checkpoint poll failing repeatedly — backend may be down` (ERROR after 5) | restore the node/index |
| Backend recovered | `backend recovered; checkpoint poll OK again` | clears the above |
| Transient blip | `category=transient`; `transient chain error; retrying` | ignore unless sustained |
| Indexer lag | `Kupo index trails the node tip` | check Kupo is keeping up |
| Funding low | `solver wallet balance is low` (or `balance_ada` / `delta_ada` trend) | top up the solver address |
| Thin margin | `thin batch margin: tips barely cover the fee` | review tip economics / `max_orders_per_tx` |
| Reorg | `chain rolled back (reorg); clearing in-flight pending state` | usually self-heals; investigate if frequent |
| Stalled book | passes run but settle 0 while orders rest | check competing solvers / cadence |
| Wrong network / anchor | startup `era-anchor sanity: ... from the node tip` | stop; fix `network_id`/`network_magic`/refs |

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
