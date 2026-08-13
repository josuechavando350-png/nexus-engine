import type { NextConfig } from "next";
import { NEXUS_SECURITY_HEADERS_BASE } from "@nexus/core/foundation/config";

const nextConfig: NextConfig = {
  transpilePackages: ["@nexus/core"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({
          key,
          value
        }))
      }
    ];
  }
};

export default nextConfig;
