import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { buildCsp, NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const prebuildPath = join(process.cwd(), ".nexus", "cortex33-prebuild.json");

function readCortex33Prebuild(): {
  prebuildDigest: string;
  edgePolicyDigest: string;
  edgePolicyJson: string;
  sourceRevision: string;
} | null {
  if (!existsSync(prebuildPath)) {
    if (process.env.NEXUS_CORTEX_33_BUILD_POLICY_FILE || process.env.NEXUS_CORTEX_33_EDGE_POLICY_FILE) {
      throw new Error("CORTEX #33 prebuild artifact is missing; run build evidence prepare before next build");
    }
    return null;
  }
  const parsed = JSON.parse(readFileSync(prebuildPath, "utf8")) as Record<string, unknown>;
  if (typeof parsed.prebuildDigest !== "string" || !SHA256.test(parsed.prebuildDigest)) throw new Error("CORTEX #33 prebuildDigest is invalid");
  if (typeof parsed.edgePolicyDigest !== "string" || !SHA256.test(parsed.edgePolicyDigest)) throw new Error("CORTEX #33 edgePolicyDigest is invalid");
  if (typeof parsed.sourceRevision !== "string" || !/^[0-9a-f]{40}$/u.test(parsed.sourceRevision)) throw new Error("CORTEX #33 sourceRevision is invalid");
  if (!parsed.edgePolicy || typeof parsed.edgePolicy !== "object" || Array.isArray(parsed.edgePolicy)) throw new Error("CORTEX #33 edgePolicy is invalid");
  return {
    prebuildDigest: parsed.prebuildDigest,
    edgePolicyDigest: parsed.edgePolicyDigest,
    edgePolicyJson: JSON.stringify(parsed.edgePolicy),
    sourceRevision: parsed.sourceRevision,
  };
}

const cortex33 = readCortex33Prebuild();
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
  env: cortex33 ? {
    NEXUS_CORTEX_33_PREBUILD_DIGEST: cortex33.prebuildDigest,
    NEXUS_CORTEX_33_EDGE_POLICY_DIGEST: cortex33.edgePolicyDigest,
    NEXUS_CORTEX_33_EDGE_POLICY_JSON: cortex33.edgePolicyJson,
    NEXUS_CORTEX_33_SOURCE_REVISION: cortex33.sourceRevision,
  } : {},
  transpilePackages: ["@nexus/core"],
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        ...NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({ key, value })),
        { key: "Content-Security-Policy", value: csp },
        ...(cortex33 ? [
          { key: "x-nexus-cortex33-prebuild", value: cortex33.prebuildDigest },
          { key: "x-nexus-cortex33-source", value: cortex33.sourceRevision },
        ] : []),
      ],
    }];
  },
};

export default nextConfig;
