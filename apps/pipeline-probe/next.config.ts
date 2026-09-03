import type { NextConfig } from "next";
import { NEXUS_CSP_BASE, NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

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
        { key: "Content-Security-Policy", value: NEXUS_CSP_BASE },
      ],
    }];
  },
};

export default nextConfig;
