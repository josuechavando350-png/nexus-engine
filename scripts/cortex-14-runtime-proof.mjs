#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const distRoot = join(repositoryRoot, "packages", "ontology", "dist", "cortex", "fraud-risk-gate");
const runtimeEntry = join(distRoot, "production-runtime.js");
const controlEntry = join(distRoot, "production-control.js");
const indexEntry = join(distRoot, "index.js");
const signingSecret = "s".repeat(64);
const networkSecret = "n".repeat(64);
const policy = Object.freeze({ challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 300, maxFutureSkewSeconds: 30 });
const requiredDist = [
  "index.js", "index.d.ts",
  "runtime-control.js", "runtime-control.d.ts",
  "production-control.js", "production-control.d.ts",
  "production-server.js", "production-server.d.ts",
  "production-runtime.js", "production-runtime.d.ts",
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
  const server = createNetServer();
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
    "-keyout", caKey, "-out", caCert,
    "-subj", "/CN=NEXUS CORTEX 14 Proof CA", "-days", "1", "-sha256",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], { stdio: "ignore" });
  execFileSync("openssl", [
    "req", "-newkey", "rsa:2048", "-nodes",
    "-keyout", serverKey, "-out", serverCsr,
    "-subj", "/CN=127.0.0.1", "-sha256",
  ], { stdio: "ignore" });
  writeFileSync(extensionFile, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=IP:127.0.0.1",
    "",
  ].join("\n"), { mode: 0o600 });
  execFileSync("openssl", [
    "x509", "-req", "-in", serverCsr,
    "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-out", serverCert, "-days", "1", "-sha256", "-extfile", extensionFile,
  ], { stdio: "ignore" });
  return Object.freeze({ caCert, serverKey, serverCert });
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

function startHttpsUpstream(tls, port) {
  let hits = 0;
  let lastHeaders = {};
  const server = createHttpsServer({ key: readFileSync(tls.serverKey), cert: readFileSync(tls.serverCert) }, (request, response) => {
    hits += 1;
    lastHeaders = request.headers;
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("real-upstream-ok");
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise(Object.freeze({
        server,
        get hits() { return hits; },
        get lastHeaders() { return lastHeaders; },
      }));
    });
  });
}

function proxyRequest(port, path, envelope, extraHeaders = {}) {
  return new Promise((resolvePromise, reject) => {
    const headers = envelope ? { "x-nexus-risk-envelope": envelope, ...extraHeaders } : extraHeaders;
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

function startRuntime(env, caCert) {
  return spawn(process.execPath, [runtimeEntry], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env, NODE_EXTRA_CA_CERTS: caCert },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function waitForHealth(child, port, expectedStatus) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CORTEX #14 runtime exited before readiness: code=${child.exitCode} signal=${child.signalCode}`);
    try {
      const response = await proxyRequest(port, "/healthz");
      if (response.status === expectedStatus) return;
    } catch {
      // bounded readiness retry
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`CORTEX #14 runtime did not reach health status ${expectedStatus}`);
}

async function stopRuntime(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(true); });
  });
  if (exited) return;
  child.kill("SIGKILL");
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

function setMode(databasePath, mode, revision) {
  const output = execFileSync(process.execPath, [controlEntry, mode, String(revision)], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXUS_CORTEX_14_DATABASE: databasePath },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output.trim());
}

async function closeHttps(server) {
  server.closeAllConnections?.();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function main() {
  assertExactSource();
  const proofDir = mkdtempSync(join(tmpdir(), "nexus-cortex14-real-proof-"));
  let runtime;
  let upstream;
  try {
    const tls = generateTlsFixture(proofDir);
    const artifactDigest = buildAndDigestProductionArtifacts();
    const risk = await import(`${pathToFileURL(indexEntry).href}?source=${expectedSha}`);
    const proxyPort = await freePort();
    let upstreamPort = await freePort();
    while (upstreamPort === proxyPort) upstreamPort = await freePort();

    const databasePath = join(proofDir, "cortex14-control.sqlite");
    const signingFile = join(proofDir, "signing.secret");
    const networkFile = join(proofDir, "network.secret");
    writeFileSync(signingFile, signingSecret, { mode: 0o600 });
    writeFileSync(networkFile, networkSecret, { mode: 0o600 });

    upstream = await startHttpsUpstream(tls, upstreamPort);
    const runtimeEnv = {
      NEXUS_CORTEX_14_PERSISTENCE_ACK: "durable-volume",
      NEXUS_CORTEX_14_DATABASE: databasePath,
      NEXUS_CORTEX_14_SIGNING_SECRET_FILE: signingFile,
      NEXUS_CORTEX_14_NETWORK_KEY_SECRET_FILE: networkFile,
      NEXUS_CORTEX_14_POLICY_JSON: JSON.stringify(policy),
      NEXUS_CORTEX_14_UPSTREAM_ORIGIN: `https://127.0.0.1:${upstreamPort}/`,
      NEXUS_CORTEX_14_PORT: String(proxyPort),
    };

    let sequence = 0;
    const envelope = (score) => {
      sequence += 1;
      const now = Date.now();
      const signed = risk.signRiskPayload({
        schemaVersion: 1,
        assessmentId: `assessment-proof-${String(sequence).padStart(8, "0")}`,
        providerId: "provider-proof-00000001",
        assessedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
        riskScore: score,
        networkKeyHash: risk.computeRiskNetworkKeyHash("127.0.0.1", networkSecret),
      }, signingSecret);
      return Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
    };

    runtime = startRuntime(runtimeEnv, tls.caCert);
    await waitForHealth(runtime, proxyPort, 503);
    const active = setMode(databasePath, "ACTIVE", 0);
    if (active.mode !== "ACTIVE" || active.revision !== 1) throw new Error(`CORTEX #14 ACTIVE CAS mismatch: ${JSON.stringify(active)}`);
    await waitForHealth(runtime, proxyPort, 200);

    const allowed = await proxyRequest(proxyPort, "/checkout?proof=1", envelope(100), {
      connection: "x-proof-hop, keep-alive",
      "x-proof-hop": "must-not-cross-proxy",
      "x-forwarded-for": "203.0.113.200",
    });
    if (allowed.status !== 200 || allowed.headers["x-nexus-risk-action"] !== "ALLOW" || allowed.body !== "real-upstream-ok") throw new Error(`CORTEX #14 ALLOW path failed: ${JSON.stringify(allowed)}`);
    if (upstream.hits !== 1 || upstream.lastHeaders["x-proof-hop"] !== undefined || upstream.lastHeaders["x-forwarded-for"] !== undefined || upstream.lastHeaders["x-nexus-risk-envelope"] !== undefined) {
      throw new Error(`CORTEX #14 header boundary failed: ${JSON.stringify({ hits: upstream.hits, headers: upstream.lastHeaders })}`);
    }

    const challenged = await proxyRequest(proxyPort, "/checkout", envelope(650));
    if (challenged.status !== 429 || JSON.parse(challenged.body).error !== "RISK_CHALLENGE" || upstream.hits !== 1) throw new Error(`CORTEX #14 CHALLENGE path failed: ${JSON.stringify(challenged)}`);

    const denied = await proxyRequest(proxyPort, "/checkout", envelope(900));
    if (denied.status !== 403 || JSON.parse(denied.body).error !== "RISK_DENIED" || upstream.hits !== 1) throw new Error(`CORTEX #14 DENY path failed: ${JSON.stringify(denied)}`);

    const observed = setMode(databasePath, "OBSERVE_ONLY", 1);
    if (observed.mode !== "OBSERVE_ONLY" || observed.revision !== 2) throw new Error(`CORTEX #14 OBSERVE_ONLY CAS mismatch: ${JSON.stringify(observed)}`);
    const observedDeny = await proxyRequest(proxyPort, "/checkout", envelope(900));
    if (observedDeny.status !== 200 || observedDeny.headers["x-nexus-risk-action"] !== "DENY" || upstream.hits !== 2) throw new Error(`CORTEX #14 OBSERVE_ONLY path failed: ${JSON.stringify(observedDeny)}`);

    const killed = setMode(databasePath, "KILLED", 2);
    if (killed.mode !== "KILLED" || killed.revision !== 3) throw new Error(`CORTEX #14 KILLED CAS mismatch: ${JSON.stringify(killed)}`);
    await waitForHealth(runtime, proxyPort, 503);
    const killedRequest = await proxyRequest(proxyPort, "/checkout", envelope(100));
    if (killedRequest.status !== 503 || JSON.parse(killedRequest.body).error !== "KILLED" || upstream.hits !== 2) throw new Error(`CORTEX #14 KILLED path failed: ${JSON.stringify(killedRequest)}`);

    let staleCasRejected = false;
    try { setMode(databasePath, "ACTIVE", 2); }
    catch { staleCasRejected = true; }
    if (!staleCasRejected) throw new Error("CORTEX #14 stale control revision was accepted");

    await stopRuntime(runtime);
    runtime = undefined;
    runtime = startRuntime(runtimeEnv, tls.caCert);
    await waitForHealth(runtime, proxyPort, 503);
    const afterRestart = await proxyRequest(proxyPort, "/checkout", envelope(100));
    if (afterRestart.status !== 503 || upstream.hits !== 2) throw new Error(`CORTEX #14 durable kill did not survive restart: ${JSON.stringify(afterRestart)}`);

    assertExactSource();
    process.stdout.write(`${JSON.stringify({
      component: "cortex-14-runtime-proof",
      sourceRevision: expectedSha,
      boundary: "compiled-localhost-risk-proxy-to-certificate-verified-local-https-upstream",
      control: "compiled-sqlite-cas-operator-control",
      persistence: "killed-state-survives-runtime-restart-with-durable-volume-ack-required",
      artifactDigest,
      verdict: "PASS",
    })}\n`);
  } finally {
    await stopRuntime(runtime).catch(() => undefined);
    if (upstream?.server) await closeHttps(upstream.server).catch(() => undefined);
    rmSync(proofDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
