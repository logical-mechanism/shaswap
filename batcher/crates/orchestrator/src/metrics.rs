//! Optional Prometheus metrics + health/readiness endpoints for a 24/7 operator.
//!
//! **Disabled by default.** `SHASWAP_METRICS_ADDR` / `SHASWAP_HEALTH_ADDR` (e.g.
//! `127.0.0.1:9100`) each start a tiny **std-only** HTTP server (no new dependencies,
//! no effect on the settle loop) serving:
//!
//! - `GET /metrics` — Prometheus text exposition of the live counters/gauges.
//! - `GET /health` — liveness: `200` while the process is up (+ a small JSON body).
//! - `GET /ready` — readiness: `200` iff a settle pass completed recently, else `503`
//!   — this catches a HUNG daemon that a crash-only watchdog (`Restart=always`) misses.
//!
//! The registry is a process-global of atomics the settle loop updates in place; the
//! server thread only reads it, so there is no locking on the hot path. Updating a
//! counter when no server is running is a cheap atomic add, so the loop is
//! unconditionally instrumented and only the HTTP server is gated on the env vars.
//!
//! The server is intentionally minimal (read the request line, route on the path,
//! one response, close) — it is meant to sit on localhost / an operator's private
//! network behind a scraper, not on the public internet.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};
use std::sync::OnceLock;
use std::time::Duration;

/// A settle pass runs once per block (~20 s). If none has completed within this many
/// seconds the daemon is considered NOT ready (hung / wedged backend / stalled).
const READY_STALENESS_SECS: u64 = 90;

/// Process-global metric registry (atomics, lock-free). The settle loop writes; the
/// HTTP server reads. See the module docs.
#[derive(Default)]
pub struct Registry {
    // --- counters (monotonic) ---
    pub passes_total: AtomicU64,
    pub settlements_total: AtomicU64,
    pub lp_fulfillments_total: AtomicU64,
    pub orders_settled_total: AtomicU64,
    pub submit_failures_total: AtomicU64,
    pub pass_failures_total: AtomicU64,
    pub backend_errors_total: AtomicU64,
    pub reorgs_total: AtomicU64,
    pub fees_lovelace_total: AtomicU64,
    pub tips_taken_lovelace_total: AtomicU64,
    // --- gauges (point-in-time, refreshed each pass) ---
    pub wallet_balance_lovelace: AtomicI64,
    pub pnl_lovelace: AtomicI64,
    pub pending_count: AtomicU64,
    pub pools_active: AtomicU64,
    pub orders_resting: AtomicU64,
    pub last_pass_slot: AtomicU64,
    pub last_pass_unixtime: AtomicU64,
    pub start_unixtime: AtomicU64,
}

static REGISTRY: OnceLock<Registry> = OnceLock::new();

/// The process-global metric registry (initialized on first use).
pub fn registry() -> &'static Registry {
    REGISTRY.get_or_init(Registry::default)
}

/// Seconds since the Unix epoch (0 if the clock is somehow before it).
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn emit(out: &mut String, name: &str, kind: &str, help: &str, value: &str) {
    out.push_str("# HELP ");
    out.push_str(name);
    out.push(' ');
    out.push_str(help);
    out.push('\n');
    out.push_str("# TYPE ");
    out.push_str(name);
    out.push(' ');
    out.push_str(kind);
    out.push('\n');
    out.push_str(name);
    out.push(' ');
    out.push_str(value);
    out.push('\n');
}

impl Registry {
    /// Has a settle pass completed within the readiness window?
    fn is_ready(&self) -> bool {
        let last = self.last_pass_unixtime.load(Relaxed);
        last != 0 && now_unix().saturating_sub(last) <= READY_STALENESS_SECS
    }

    /// Prometheus text exposition (format version 0.0.4).
    fn render_prometheus(&self) -> String {
        let mut s = String::with_capacity(2048);
        let c = |s: &mut String, name, help, v: u64| emit(s, name, "counter", help, &v.to_string());
        let g_u = |s: &mut String, name, help, v: u64| emit(s, name, "gauge", help, &v.to_string());
        let g_i = |s: &mut String, name, help, v: i64| emit(s, name, "gauge", help, &v.to_string());

        c(
            &mut s,
            "shaswap_passes_total",
            "Settle passes run.",
            self.passes_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_settlements_total",
            "Settlement txs submitted.",
            self.settlements_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_lp_fulfillments_total",
            "LP-intent fulfillments submitted.",
            self.lp_fulfillments_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_orders_settled_total",
            "Orders included in submitted settlements.",
            self.orders_settled_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_submit_failures_total",
            "Submit failures (tx may or may not have landed).",
            self.submit_failures_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_pass_failures_total",
            "Passes that aborted on a chain-read error.",
            self.pass_failures_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_backend_errors_total",
            "Checkpoint-poll / backend errors.",
            self.backend_errors_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_reorgs_total",
            "Detected chain rollbacks (checkpoint decreases).",
            self.reorgs_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_fees_lovelace_total",
            "Cumulative tx fees paid (lovelace).",
            self.fees_lovelace_total.load(Relaxed),
        );
        c(
            &mut s,
            "shaswap_tips_taken_lovelace_total",
            "Cumulative tips taken (lovelace).",
            self.tips_taken_lovelace_total.load(Relaxed),
        );

        g_i(
            &mut s,
            "shaswap_wallet_balance_lovelace",
            "Solver wallet ADA at the last pass (lovelace).",
            self.wallet_balance_lovelace.load(Relaxed),
        );
        g_i(
            &mut s,
            "shaswap_pnl_lovelace",
            "Wallet drift since start (realized P&L, lovelace).",
            self.pnl_lovelace.load(Relaxed),
        );
        g_u(
            &mut s,
            "shaswap_pending_count",
            "In-flight (submitted-unconfirmed) inputs held pending.",
            self.pending_count.load(Relaxed),
        );
        g_u(
            &mut s,
            "shaswap_pools_active",
            "Pools discovered at the last pass.",
            self.pools_active.load(Relaxed),
        );
        g_u(
            &mut s,
            "shaswap_orders_resting",
            "Settleable orders at the last pass.",
            self.orders_resting.load(Relaxed),
        );
        g_u(
            &mut s,
            "shaswap_last_pass_slot",
            "Node tip slot at the last pass.",
            self.last_pass_slot.load(Relaxed),
        );
        g_u(
            &mut s,
            "shaswap_last_pass_unixtime",
            "Unix time of the last completed pass.",
            self.last_pass_unixtime.load(Relaxed),
        );
        g_u(
            &mut s,
            "shaswap_start_unixtime",
            "Unix time the daemon started.",
            self.start_unixtime.load(Relaxed),
        );
        s
    }

    /// A small JSON liveness/readiness body (hand-built — no serde needed).
    fn render_health(&self) -> String {
        let now = now_unix();
        let last = self.last_pass_unixtime.load(Relaxed);
        let start = self.start_unixtime.load(Relaxed);
        // -1 = no pass has completed yet (distinct from "0 seconds ago").
        let age: i64 = if last == 0 {
            -1
        } else {
            i64::try_from(now.saturating_sub(last)).unwrap_or(i64::MAX)
        };
        let uptime = if start == 0 {
            0
        } else {
            now.saturating_sub(start)
        };
        format!(
            "{{\"status\":\"ok\",\"ready\":{},\"uptime_s\":{},\"last_pass_slot\":{},\"last_pass_age_s\":{},\"pending\":{}}}\n",
            self.is_ready(),
            uptime,
            self.last_pass_slot.load(Relaxed),
            age,
            self.pending_count.load(Relaxed),
        )
    }
}

/// Start a metrics/health HTTP server on `addr` in a background thread. Returns an
/// error only on the initial bind; a per-connection failure is swallowed (the server
/// keeps accepting). A bind failure is NON-fatal to the batcher — the caller logs and
/// runs without the endpoint.
pub fn serve(addr: &str) -> std::io::Result<std::net::SocketAddr> {
    let listener = TcpListener::bind(addr)?;
    let bound = listener.local_addr()?;
    std::thread::Builder::new()
        .name(format!("shaswap-http-{bound}"))
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                handle_conn(stream);
            }
        })?;
    Ok(bound)
}

fn handle_conn(mut stream: TcpStream) {
    // Bound a slow/idle client so it can't wedge the accept loop.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 1024];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    // Request line: "GET /path HTTP/1.1" — the path is the second token.
    let path = req.split_whitespace().nth(1).unwrap_or("/");
    let reg = registry();
    let (status, ctype, body) = match path {
        "/metrics" => (
            "200 OK",
            "text/plain; version=0.0.4",
            reg.render_prometheus(),
        ),
        "/health" => ("200 OK", "application/json", reg.render_health()),
        "/ready" => {
            let code = if reg.is_ready() {
                "200 OK"
            } else {
                "503 Service Unavailable"
            };
            (code, "application/json", reg.render_health())
        }
        _ => ("404 Not Found", "text/plain", "not found\n".to_string()),
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prometheus_exposition_has_names_types_and_values() {
        let r = Registry::default();
        r.passes_total.store(7, Relaxed);
        r.wallet_balance_lovelace.store(-123, Relaxed);
        let p = r.render_prometheus();
        assert!(p.contains("# TYPE shaswap_passes_total counter"));
        assert!(p.contains("\nshaswap_passes_total 7\n"));
        assert!(p.contains("# TYPE shaswap_wallet_balance_lovelace gauge"));
        // negative gauges (a P&L drawdown) render with the sign.
        assert!(p.contains("\nshaswap_wallet_balance_lovelace -123\n"));
    }

    #[test]
    fn readiness_flips_with_a_recent_pass() {
        let r = Registry::default();
        // No pass yet → not ready; the body reports a -1 age and ready:false.
        assert!(!r.is_ready());
        let h = r.render_health();
        assert!(h.contains("\"ready\":false"), "{h}");
        assert!(h.contains("\"last_pass_age_s\":-1"), "{h}");
        // A pass just now → ready.
        r.last_pass_unixtime.store(now_unix(), Relaxed);
        assert!(r.is_ready());
        assert!(r.render_health().contains("\"ready\":true"));
        // A pass long ago → stale → not ready.
        r.last_pass_unixtime.store(
            now_unix().saturating_sub(READY_STALENESS_SECS + 10),
            Relaxed,
        );
        assert!(!r.is_ready());
    }

    #[test]
    fn http_server_answers_metrics_health_ready_and_404() {
        // End-to-end through a real socket: bind an ephemeral port, then drive the
        // routes. Uses the process-global registry (what the server reads).
        registry().passes_total.fetch_add(1, Relaxed);
        let addr = serve("127.0.0.1:0").expect("bind ephemeral port");

        let metrics = http_get(addr, "/metrics");
        assert!(metrics.starts_with("HTTP/1.1 200 OK"), "{metrics}");
        assert!(metrics.contains("shaswap_passes_total"));
        assert!(metrics.contains("Content-Type: text/plain"));

        assert!(http_get(addr, "/health").contains("\"status\":\"ok\""));

        // /ready: 503 with no recent pass, 200 once a pass timestamp is fresh.
        registry().last_pass_unixtime.store(0, Relaxed);
        assert!(http_get(addr, "/ready").starts_with("HTTP/1.1 503"));
        registry().last_pass_unixtime.store(now_unix(), Relaxed);
        assert!(http_get(addr, "/ready").starts_with("HTTP/1.1 200"));

        assert!(http_get(addr, "/nope").starts_with("HTTP/1.1 404"));
    }

    fn http_get(addr: std::net::SocketAddr, path: &str) -> String {
        let mut s = TcpStream::connect(addr).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
            .expect("write request");
        let mut buf = Vec::new();
        let _ = s.read_to_end(&mut buf); // server sends Connection: close → EOF
        String::from_utf8_lossy(&buf).into_owned()
    }
}
