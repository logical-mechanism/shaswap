import type { NextConfig } from "next";

/**
 * Next.js 16 uses Turbopack by default, which resolves MeshJS's
 * WebAssembly-backed serialization libraries natively — no custom bundler
 * config is required for the skeleton. Keep this minimal; add a `turbopack`
 * block here if a future MeshJS feature needs loader/resolve tweaks.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
