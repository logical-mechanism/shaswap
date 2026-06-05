# Data availability & failure modes

> How ShaSwap reads chain state, why that never makes a provider a "mortal external
> dependency" of the protocol, and what happens when a provider is down. Source:
> BLUEPRINT §3 (no mortal external dependency in the core), CLAUDE.md (data-access seam).

## The invariant

> **No mortal external dependency in the core** — no oracle/indexer/server the protocol
> can't live without.

This is a statement about the **protocol**, not about any one client. The settlement
validator and the pools depend on nothing but the Cardano ledger: all state (orders,
pools, reserves, LP supply) lives **on-chain** and is re-derivable from the chain alone.
No indexer is part of the trust base; none can censor settlement or withhold funds.

## How clients read (the provider seam)

Reading the chain efficiently still needs *some* index. Both clients put that behind a
swappable seam so no module is bound to a specific provider:

- **dApp:** every chain read goes through `getDataProvider()`
  ([`app/src/lib/data/`](../../app/src/lib/data/)). Default backend is Blockfrost; the
  seam also has a `MockProvider` (offline tests/CI) and is structured so Kupo+Ogmios or a
  self-hosted node can drop in. No UI module calls a provider SDK directly.
- **batcher:** reads via the `ChainBackend` trait
  ([`batcher/crates/chain/`](../../batcher/crates/chain/)), implemented today over
  Kupo+Ogmios. Any backend that satisfies the trait works.

Because the seam is the only coupling, an operator can move to their **own** node
(e.g. Dolos, or a full node + Kupo/Ogmios) without touching app or solver logic. That is
what keeps the "no mortal dependency" claim true in practice: the provider is a
convenience read path, not a trust anchor.

## Failure modes (provider down or degraded)

The clients **fail safe**: a read outage can never move or misreport funds, because all
writes are user-signed and validator-checked.

| Failure | dApp behavior | Why it's safe |
|---|---|---|
| Provider unreachable | Reads error or return empty (no pools/orders shown); a clear "couldn't load / try again" state. Never fabricates or shows stale-as-fresh data. | Nothing is auto-submitted; the user sees the outage, not a wrong number. |
| Stale index (lag) | A just-posted order may not list yet; the dApp also records local "pending" so it shows immediately. | The chain is the truth; lag only delays *display*, not settlement or reclaim. |
| Quote/price read fails | Posting is disabled until a fresh quote loads (the floor must match the current pair+amount). | Prevents binding an order to a stale floor or the wrong pool. |
| Wrong-network provider | App refuses to start if the Blockfrost key prefix doesn't match `NEXT_PUBLIC_NETWORK`. | Can't accidentally read/post against the wrong network. |

A batcher likewise treats backend errors as pass-level failures (skip the pool / abort the
pass), never as a reason to submit an unverified tx — every tx is `EvaluateTx`-gated
before submit.

## Self-hosting the read path

To run ShaSwap with **no third-party data dependency at all**:

1. Run your own Cardano node.
2. Run Kupo + Ogmios against it (the batcher backend), or Dolos.
3. Point the batcher's `deployment.json` at your `kupo_url` / `ogmios_url`.
4. For the dApp, implement a `getDataProvider()` backend over your node and select it via
   the data seam (no other code changes).

At that point every component the protocol relies on is operated by you, and the only
shared infrastructure is the Cardano network itself.
