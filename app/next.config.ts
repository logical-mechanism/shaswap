import type { NextConfig } from "next";

/**
 * Next.js 16 uses Turbopack by default, which resolves MeshJS's
 * WebAssembly-backed serialization libraries natively — no custom bundler
 * config is required for the skeleton. Keep this minimal; add a `turbopack`
 * block here if a future MeshJS feature needs loader/resolve tweaks.
 */

/**
 * Content-Security-Policy — shipped as **Report-Only** for now.
 *
 * The app can't run under a strict (nonce-based) CSP yet: there's an inline no-FOUC
 * theme script in layout.tsx, Next injects its own inline bootstrap/hydration scripts,
 * and MeshJS compiles WebAssembly (needs `'wasm-unsafe-eval'`). Enforcing a policy that
 * covers all of that safely requires per-request nonces via middleware. Until then we
 * report violations (no enforcement, zero breakage risk) so the policy can be tightened
 * from real data, then promoted to an enforced `Content-Security-Policy`.
 *
 * Notes on directives:
 * - fonts are self-hosted by next/font/google (build-time) → `font-src 'self'`, no Google origin.
 * - chain reads go through our own same-origin `/api/*`; wallets inject via window.cardano
 *   (no page-level connect), so `connect-src` stays same-origin + https (wallets may call out).
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  // Enforce HTTPS for two years incl. subdomains (preprod/app/mainnet all serve TLS on DO).
  // `preload` is inert until manually submitted to hstspreload.org — safe to advertise intent.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Enforced clickjacking protection (CSP frame-ancestors below only *reports* for now).
  { key: "X-Frame-Options", value: "DENY" },
  // allow-popups so injected-wallet popups (hardware bridges, etc.) keep their opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
