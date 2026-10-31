import { readFileSync } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";

/** Explicit proxy mode. DNS is delegated only for exact caller-selected hosts. */
export function remoteDNSHosts() {
  return (process.env.REPLICA_PROXY_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}
export function remoteDNSAllowed(host: string) {
  return (
    Boolean(process.env.REPLICA_PROXY_URL) &&
    remoteDNSHosts().includes(host.toLowerCase()) &&
    !/(^|\.)(localhost|local|internal)$/.test(host)
  );
}
export function transportOptions(): {
  server?: string;
  bypass?: string;
  username?: string;
  password?: string;
} {
  const address = process.env.REPLICA_PROXY_URL;
  if (!address) return {};
  const u = new URL(address);
  if (!["http:", "https:", "socks5:"].includes(u.protocol))
    throw new Error("Proxy no admitido.");
  const username = decodeURIComponent(u.username),
    password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  return {
    server: u.href.replace(/\/$/, ""),
    bypass: "127.0.0.1,localhost,[::1]",
    ...(username ? { username, password } : {}),
  };
}
export function certificatePin() {
  const file = process.env.REPLICA_CA_CERT;
  if (!file) return undefined;
  const cert = new X509Certificate(readFileSync(file));
  return createHash("sha256")
    .update(cert.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
}
