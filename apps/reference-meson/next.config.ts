import type { NextConfig } from "next";
import { NEXUS_CSP_BASE, NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

// This app currently references no external domain (fonts, scripts,
// images, analytics, maps, etc. — verified by grep during NEXUS V1.2
// hardening). The unextended Core CSP baseline is safe to apply as-is.
// The moment this app needs an external source, extend it with
// buildCsp({...}) from "@nexus/core/foundation/config" instead of
// hand-writing a parallel CSP string.
const nextConfig: NextConfig = {
  transpilePackages: ["@nexus/core"],
  generateBuildId: async () => process.env.NEXUS_BUILD_ID ?? "nexus-local-build",
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          ...NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({ key, value })),
          { key: "Content-Security-Policy", value: NEXUS_CSP_BASE }
        ]
      }
    ];
  }
};

export default nextConfig;
