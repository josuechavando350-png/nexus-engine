import type { NextConfig } from "next";
import { NEXUS_CSP_BASE, NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

const nextConfig: NextConfig = {
  transpilePackages: ["@nexus/core", "@nexus/experience"],
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
