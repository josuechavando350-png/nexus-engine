#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const distRoot = join(repositoryRoot, "packages", "ontology", "dist", "cortex", "fraud-risk-gate");
const requiredDist = [
  "index.js",
  "index.d.ts",
  "runtime-control.js",
  "runtime-control.d.ts",
  "production-control.js",
  "production-control.d.ts",
  "production-server.js",
  "production-server.d.ts",
  "production-runtime.js",
  "production-runtime.d.ts",
];

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("NEXUS_VALIDATED_SHA must be an exact SHA-1");
  if (head !== expectedSha) throw new Error(`CORTEX #14 runtime proof source mismatch: ${head} != ${expectedSha}`);
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("CORTEX #14 runtime proof requires a pristine tracked checkout");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a local proof port");
  const port = address.port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

function generateTlsFixture(directory) {
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serverKey = join(directory, "server.key");
  const serverCsr = join(directory, "server.csr");
  const serverCert = join(directory, "server.crt");
  const extensionFile = join(directory, "server.ext");

  execFileSync("openssl", ["version"], { stdio: "inherit" });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", caKey,
    "-out", caCert,
    "-subj", "/CN=NEXUS CORTEX 14 Proof CA",
    "-days", "1",
    "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKey,
    "-out", serverCsr,
    "-subj", "/CN=127.0.0.1",
    "-sha256",
  ], { stdio: "ignore" });
  writeFileSync(extensionFile, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=IP:127.0.0.1",
    "",
  ].join("\n"), { mode: 0o600 });
  execFileSync("openssl", [
    "x509", "-req",
    "-in", serverCsr,
    "-CA", caCert,
    "-CAkey", caKey,
    "-CAcreateserial",
    "-out", serverCert,
    "-days", "1",
    "-sha256",
    "-extfile", extensionFile,
  ], { stdio: "ignore" });
  return caCert;
}

function buildAndDigestProductionArtifacts() {
  execFileSync("pnpm", ["--filter", "@nexus/ontology", "build"], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXUS_VALIDATED_SHA: expectedSha },
    stdio: "inherit",
  });
  const digest = createHash("sha256");
  for (const name of requiredDist) {
    const path = join(distRoot, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1) throw new Error(`missing CORTEX #14 production artifact: ${name}`);
    digest.update(name, "utf8");
    digest.update("\0", "utf8");
    digest.update(readFileSync(path));
    digest.update("\0", "utf8");
  }
  return `sha256:${digest.digest("hex")}`;
}

async function main() {
  assertExactSource();
  const proofDir = mkdtempSync(join(tmpdir(), "nexus-cortex14-real-proof-"));
  try {
    const caCert = generateTlsFixture(proofDir);
    const artifactDigest = buildAndDigestProductionArtifacts();
    const proxyPort = await freePort();
    let upstreamPort = await freePort();
    while (upstreamPort === proxyPort) upstreamPort = await freePort();

    execFileSync("pnpm", [
      "exec", "vitest", "run",
      "packages/ontology/cortex/fraud-risk-gate/production-real-runtime.test.ts",
      "--testTimeout=60000",
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NEXUS_VALIDATED_SHA: expectedSha,
        NEXUS_CORTEX_14_REAL_PROOF: "1",
        NEXUS_CORTEX_14_PROOF_DIR: proofDir,
        NEXUS_CORTEX_14_PROXY_PORT: String(proxyPort),
        NEXUS_CORTEX_14_UPSTREAM_PORT: String(upstreamPort),
        NODE_EXTRA_CA_CERTS: caCert,
      },
      stdio: "inherit",
      timeout: 120_000,
    });

    assertExactSource();
    process.stdout.write(`${JSON.stringify({
      component: "cortex-14-runtime-proof",
      sourceRevision: expectedSha,
      boundary: "localhost-risk-proxy-to-localhost-verified-TLS-upstream",
      persistence: "sqlite-control-restart-proof-with-durable-volume-ack-required",
      artifactDigest,
      verdict: "PASS",
    })}\n`);
  } finally {
    rmSync(proofDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
