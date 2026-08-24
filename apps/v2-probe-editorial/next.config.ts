import type { NextConfig } from "next";
import { NEXUS_CSP_BASE, NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

const deterministicBuildId = () => {
  const value = process.env.NEXUS_BUILD_ID?.trim();
  if (process.env.NEXUS_DETERMINISTIC_BUILD === "1" && !value) throw new Error("NEXUS_BUILD_ID is required for deterministic builds");
  return value || process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "nexus-local-build";
};

const nextConfig: NextConfig = {
  // Next 15 webpack workers can assign different module IDs under Node 24.
  // Serialize only hermetic verification builds; normal app builds keep Next defaults.
  experimental: process.env.NEXUS_DETERMINISTIC_BUILD === "1"
    ? { cpus: 1, webpackBuildWorker: false }
    : {},
  transpilePackages: ["@nexus/core", "@nexus/experience"],
  generateBuildId: async () => deterministicBuildId(),
  async headers() {
    return [{ source: "/(.*)", headers: [...NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({ key, value })), { key: "Content-Security-Policy", value: NEXUS_CSP_BASE }] }];
  }
};

export default nextConfig;
