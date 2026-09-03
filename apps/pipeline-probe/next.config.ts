import type { NextConfig } from "next";

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
};

export default nextConfig;
