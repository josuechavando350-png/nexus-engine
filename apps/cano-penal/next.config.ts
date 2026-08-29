import type { NextConfig } from "next";
import { NEXUS_SECURITY_HEADERS_BASE, buildCsp } from "@nexus/core/foundation/config";
import { redirects } from "./redirects";

const csp = buildCsp({
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "https://www.googletagmanager.com",
    "https://www.googleadservices.com",
    "https://www.google.com",
    "https://pagead2.googlesyndication.com",
    "https://googleads.g.doubleclick.net"
  ],
  "style-src": ["'self'", "'unsafe-inline'"],
  "connect-src": [
    "'self'",
    "https://www.google-analytics.com",
    "https://www.googletagmanager.com",
    "https://www.googleadservices.com",
    "https://googleads.g.doubleclick.net",
    "https://ad.doubleclick.net",
    "https://pagead2.googlesyndication.com",
    "https://www.google.com",
    "https://google.com"
  ],
  "img-src": [
    "'self'",
    "data:",
    "https://www.google-analytics.com",
    "https://www.googletagmanager.com",
    "https://www.googleadservices.com",
    "https://googleads.g.doubleclick.net",
    "https://pagead2.googlesyndication.com",
    "https://ad.doubleclick.net",
    "https://www.google.com",
    "https://google.com"
  ],
  "frame-src": [
    "'self'",
    "https://www.googletagmanager.com",
    "https://www.google.com"
  ]
});

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: process.env.NEXUS_DETERMINISTIC_BUILD === "1" ? { cpus: 1, webpackBuildWorker: false } : {},
  transpilePackages: ["@nexus/core"],
  generateBuildId: async () => {
    const deterministicBuildId = process.env.NEXUS_BUILD_ID?.trim();
    if (process.env.NEXUS_DETERMINISTIC_BUILD === "1" && !deterministicBuildId) throw new Error("NEXUS_BUILD_ID is required for deterministic builds");
    return deterministicBuildId || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "nexus-local-build";
  },
  async redirects() {
    return redirects;
  },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        ...NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({ key, value })),
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "X-DNS-Prefetch-Control", value: "on" },
        { key: "Content-Security-Policy", value: csp }
      ]
    }];
  }
};

export default nextConfig;
