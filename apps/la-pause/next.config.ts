import type { NextConfig } from "next";
import {
  NEXUS_SECURITY_HEADERS_BASE,
  buildCsp
} from "@nexus/core/foundation/config";

const laPauseCsp = buildCsp({
  "script-src": ["'self'", "'unsafe-inline'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"]
});

const nextConfig: NextConfig = {
  transpilePackages: ["@nexus/core", "@nexus/experience"],
  eslint: {
    ignoreDuringBuilds: true
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          ...NEXUS_SECURITY_HEADERS_BASE.map(({ key, value }) => ({ key, value })),
          { key: "Content-Security-Policy", value: laPauseCsp }
        ]
      }
    ];
  }
};

export default nextConfig;
