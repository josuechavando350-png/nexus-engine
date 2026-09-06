import type { NextConfig } from "next";
import { buildCsp, NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

const csp = buildCsp({
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "font-src": ["'self'"],
});

const nextConfig: NextConfig = {
  experimental: process.env.NEXUS_DETERMINISTIC_BUILD === "1"
    ? { cpus: 1, webpackBuildWorker: false }
    : {},
  generateBuildId: async () => {
    const buildId = process.env.NEXUS_BUILD_ID?.trim();
    if (process.env.NEXUS_DETERMINISTIC_BUILD === "1" && !buildId) {
      throw new Error("NEXUS_BUILD_ID is required for deterministic builds");
    }
    return buildId || process.env.GITHUB_SHA || "nexus-local-build";
  },
  transpilePackages: ["@nexus/core"],
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        ...NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({ key, value })),
        { key: "Content-Security-Policy", value: csp },
      ],
    }];
  },
};

export default nextConfig;