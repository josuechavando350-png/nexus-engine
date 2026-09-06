#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const distRoot = join(repositoryRoot, "packages", "ontology", "dist", "cortex", "semantic-search");
const runtimeEntry = join(distRoot, "production-runtime.js");
const controlEntry = join(distRoot, "production-control.js");
const requiredDist = [
  "index.js", "index.d.ts",
  "runtime-control.js", "runtime-control.d.ts",
  "production-control.js", "production-control.d.ts",
  "production-server.js", "production-server.d.ts",
  "production-runtime.js", "production-runtime.d.ts",
];
const writeToken = "w".repeat(64);
const readToken = "r".repeat(64);
const embeddingToken = "e".repeat(64);

function git(args) { return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim(); }

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("NEXUS_VALIDATED_SHA must be an exact SHA-1");
  if (head !== expectedSha) throw new Error(`CORTEX #15 runtime proof source mismatch: ${head} != ${expectedSha}`);
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("CORTEX #15 runtime proof requires a pristine tracked checkout");
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate proof port");
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
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-subj", "/CN=NEXUS CORTEX 15 Proof CA", "-days", "1", "-sha256", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-subj", "/CN=127.0.0.1", "-sha256"], { stdio: "ignore" });
  writeFileSync(extensionFile, ["basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", "subjectAltName=IP:127.0.0.1", ""].join("\n"), { mode: 0o600 });
  execFileSync("openssl", ["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", serverCert, "-days", "1", "-sha256", "-extfile", extensionFile], { stdio: "ignore" });
  return Object.freeze({ caCert, serverKey, serverCert });
}

function buildArtifacts() {
  execFileSync("pnpm", ["--filter", "@nexus/ontology", "build"], { cwd: repositoryRoot, env: { ...process.env, NEXUS_VALIDATED_SHA: expectedSha }, stdio: "inherit" });
  const digest = createHash("sha256");
  for (const name of requiredDist) {
    const path = join(distRoot, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1) throw new Error(`missing CORTEX #15 production artifact: ${name}`);
    digest.update(name); digest.update("\0"); digest.update(readFileSync(path)); digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function startEmbeddingProvider(tls, port) {
  let hits = 0;
  const server = createHttpsServer({ key: readFileSync(tls.serverKey), cert: readFileSync(tls.serverCert) }, (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/embeddings" || request.headers.authorization !== `Bearer ${embeddingToken}`) {
        response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "UNAUTHORIZED" })); return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model !== "proof-embedding-model-v1" || !Array.isArray(body.input) || body.input.length < 1) {
        response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "INVALID_INPUT" })); return;
      }
      hits += 1;
      const data = body.input.map((text, index) => ({ index, embedding: String(text).includes("penal") || String(text).includes("defensa") ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0] }));
      const encoded = JSON.stringify({ data });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store" });
      response.end(encoded);
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolvePromise(Object.freeze({ server, get hits() { return hits; } })); });
  });
}

function apiRequest(port, path, token, body) {
  return new Promise((resolvePromise, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}) } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

function setMode(databasePath, mode, revision) {
  return JSON.parse(execFileSync(process.execPath, [controlEntry, mode, String(revision)], { cwd: repositoryRoot, env: { ...process.env, NEXUS_CORTEX_15_DATABASE: databasePath }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
}

function startRuntime(env, caCert) {
  return spawn(process.execPath, [runtimeEntry], { cwd: repositoryRoot, env: { ...process.env, ...env, NODE_EXTRA_CA_CERTS: caCert }, stdio: ["ignore", "inherit", "inherit"] });
}

async function waitHealth(child, port, status) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CORTEX #15 runtime exited before readiness: code=${child.exitCode} signal=${child.signalCode}`);
    try { if ((await apiRequest(port, "/healthz", readToken)).status === status) return; } catch { /* bounded readiness retry */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`CORTEX #15 runtime did not reach health status ${status}`);
}

async function stopRuntime(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolvePromise) => { const timer = setTimeout(() => resolvePromise(false), 10_000); child.once("exit", () => { clearTimeout(timer); resolvePromise(true); }); });
  if (exited) return;
  child.kill("SIGKILL");
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function main() {
  assertExactSource();
  const proofDir = mkdtempSync(join(tmpdir(), "nexus-cortex15-real-proof-"));
  let provider;
  let runtime;
  try {
    const artifactDigest = buildArtifacts();
    const tls = generateTlsFixture(proofDir);
    const cortexPort = await freePort();
    let providerPort = await freePort();
    while (providerPort === cortexPort) providerPort = await freePort();
    provider = await startEmbeddingProvider(tls, providerPort);

    const databasePath = join(proofDir, "cortex15.sqlite");
    const writeFile = join(proofDir, "write.secret");
    const readFile = join(proofDir, "read.secret");
    const embeddingFile = join(proofDir, "embedding.secret");
    writeFileSync(writeFile, writeToken, { mode: 0o600 });
    writeFileSync(readFile, readToken, { mode: 0o600 });
    writeFileSync(embeddingFile, embeddingToken, { mode: 0o600 });

    const active = setMode(databasePath, "ACTIVE", 0);
    if (active.mode !== "ACTIVE" || active.revision !== 1) throw new Error("CORTEX #15 durable control did not activate from revision 0");
    const env = {
      NEXUS_CORTEX_15_PERSISTENCE_ACK: "durable-volume",
      NEXUS_CORTEX_15_DATABASE: databasePath,
      NEXUS_CORTEX_15_WRITE_TOKEN_FILE: writeFile,
      NEXUS_CORTEX_15_READ_TOKEN_FILE: readFile,
      NEXUS_CORTEX_15_EMBEDDING_ENDPOINT: `https://127.0.0.1:${providerPort}/v1/embeddings`,
      NEXUS_CORTEX_15_EMBEDDING_MODEL_ID: "proof-embedding-model-v1",
      NEXUS_CORTEX_15_EMBEDDING_TOKEN_FILE: embeddingFile,
      NEXUS_CORTEX_15_PORT: String(cortexPort),
    };
    runtime = startRuntime(env, tls.caCert);
    await waitHealth(runtime, cortexPort, 200);

    const documents = [
      { id: "proof-doc-0001", text: "defensa penal audiencia urgente", landingPath: "/proof" },
      { id: "proof-doc-0002", text: "contratos mercantiles empresas", landingPath: "/explore" },
    ];
    const indexed = await apiRequest(cortexPort, "/v1/documents", writeToken, { documents });
    if (indexed.status !== 200 || indexed.body?.semantic !== 2 || indexed.body?.lexicalOnly !== 0) throw new Error(`CORTEX #15 real provider indexing failed: ${JSON.stringify(indexed)}`);
    const searched = await apiRequest(cortexPort, "/v1/search", readToken, { query: "defensa penal", options: { topK: 2, minSemanticCoverage: 1 } });
    if (searched.status !== 200 || searched.body?.mode !== "ACTIVE" || searched.body?.result?.mode !== "HYBRID" || searched.body?.result?.semanticCoverage !== 1 || searched.body?.result?.modelId !== "proof-embedding-model-v1") throw new Error(`CORTEX #15 hybrid search proof failed: ${JSON.stringify(searched)}`);
    if (provider.hits < 2) throw new Error("CORTEX #15 proof did not traverse the real HTTPS embedding adapter for indexing and query");

    const observed = setMode(databasePath, "OBSERVE_ONLY", 1);
    if (observed.revision !== 2) throw new Error("CORTEX #15 OBSERVE_ONLY transition failed");
    const blockedWrite = await apiRequest(cortexPort, "/v1/documents", writeToken, { documents: [{ id: "proof-doc-0003", text: "should not persist", landingPath: "/visit" }] });
    if (blockedWrite.status !== 503) throw new Error("CORTEX #15 OBSERVE_ONLY did not prevent index mutation");
    const observedSearch = await apiRequest(cortexPort, "/v1/search", readToken, { query: "contratos", options: { topK: 2, minSemanticCoverage: 1 } });
    if (observedSearch.status !== 200 || observedSearch.body?.mode !== "OBSERVE_ONLY") throw new Error("CORTEX #15 OBSERVE_ONLY did not preserve read path");

    const killed = setMode(databasePath, "KILLED", 2);
    if (killed.revision !== 3) throw new Error("CORTEX #15 KILLED transition failed");
    await waitHealth(runtime, cortexPort, 503);
    if ((await apiRequest(cortexPort, "/v1/search", readToken, { query: "defensa", options: { topK: 2, minSemanticCoverage: 1 } })).status !== 503) throw new Error("CORTEX #15 KILLED mode did not close search boundary");

    await stopRuntime(runtime); runtime = undefined;
    runtime = startRuntime(env, tls.caCert);
    await waitHealth(runtime, cortexPort, 503);

    process.stdout.write(`${JSON.stringify({ component: "cortex-15-runtime-proof", sourceSha: expectedSha, artifactDigest, providerTransport: "certificate-verified-https", indexedSemanticDocuments: 2, searchMode: "HYBRID", rollback: "OBSERVE_ONLY_WRITE_BLOCKED_AND_KILLED_PERSISTED" })}\n`);
  } finally {
    await stopRuntime(runtime);
    if (provider?.server) await closeServer(provider.server);
    rmSync(proofDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
