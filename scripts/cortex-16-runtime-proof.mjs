#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const distRoot = join(repositoryRoot, "packages", "ontology", "dist", "cortex", "creative-traceability");
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
const signingSecret = "s".repeat(64);

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("NEXUS_VALIDATED_SHA must be an exact SHA-1");
  if (head !== expectedSha) throw new Error(`CORTEX #16 runtime proof source mismatch: ${head} != ${expectedSha}`);
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("CORTEX #16 runtime proof requires a pristine tracked checkout");
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
  if (!address || typeof address === "string") throw new Error("failed to allocate CORTEX #16 proof port");
  const port = address.port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

function buildArtifacts() {
  execFileSync("pnpm", ["--filter", "@nexus/ontology", "build"], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXUS_VALIDATED_SHA: expectedSha },
    stdio: "inherit",
  });
  const digest = createHash("sha256");
  for (const name of requiredDist) {
    const path = join(distRoot, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1) throw new Error(`missing CORTEX #16 production artifact: ${name}`);
    digest.update(name);
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function apiRequest(port, path, token, body) {
  return new Promise((resolvePromise, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}),
      },
    }, (response) => {
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
  return JSON.parse(execFileSync(process.execPath, [controlEntry, mode, String(revision)], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXUS_CORTEX_16_DATABASE: databasePath },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim());
}

function startRuntime(env) {
  return spawn(process.execPath, [runtimeEntry], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function waitHealth(child, port, expectedStatus) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CORTEX #16 runtime exited before readiness: code=${child.exitCode} signal=${child.signalCode}`);
    try {
      if ((await apiRequest(port, "/healthz")).status === expectedStatus) return;
    } catch {
      // bounded readiness retry
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`CORTEX #16 runtime did not reach health status ${expectedStatus}`);
}

async function stopRuntime(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
  if (exited) return;
  child.kill("SIGKILL");
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

async function main() {
  assertExactSource();
  const proofDir = mkdtempSync(join(tmpdir(), "nexus-cortex16-real-proof-"));
  let runtime;
  try {
    const artifactDigest = buildArtifacts();
    const cortexPort = await freePort();
    const databasePath = join(proofDir, "cortex16.sqlite");
    const writeFile = join(proofDir, "write.secret");
    const readFile = join(proofDir, "read.secret");
    const signingFile = join(proofDir, "signing.secret");
    writeFileSync(writeFile, writeToken, { mode: 0o600 });
    writeFileSync(readFile, readToken, { mode: 0o600 });
    writeFileSync(signingFile, signingSecret, { mode: 0o600 });

    const active = setMode(databasePath, "ACTIVE", 0);
    if (active.mode !== "ACTIVE" || active.revision !== 1) throw new Error("CORTEX #16 durable control did not activate from revision 0");

    const env = {
      NEXUS_CORTEX_16_PERSISTENCE_ACK: "durable-volume",
      NEXUS_CORTEX_16_DATABASE: databasePath,
      NEXUS_CORTEX_16_WRITE_TOKEN_FILE: writeFile,
      NEXUS_CORTEX_16_READ_TOKEN_FILE: readFile,
      NEXUS_CORTEX_16_SIGNING_SECRET_FILE: signingFile,
      NEXUS_CORTEX_16_PORT: String(cortexPort),
    };
    runtime = startRuntime(env);
    await waitHealth(runtime, cortexPort, 200);

    const creative = {
      creativeId: "proof-creative-alpha",
      version: "proof-version-0001",
      assetDigests: [`sha256:${"a".repeat(64)}`],
      deploymentKeys: ["proof-campaign-0001", "proof-adgroup-0001"],
      activatedAt: "2026-09-06T00:00:00.000Z",
    };
    const registered = await apiRequest(cortexPort, "/v1/creatives/register", writeToken, creative);
    if (registered.status !== 201 || !registered.body?.record?.traceKey || !registered.body?.record?.manifestDigest || !registered.body?.signedTrace?.signature) {
      throw new Error(`CORTEX #16 registration proof failed: ${JSON.stringify(registered)}`);
    }
    const traceKey = registered.body.record.traceKey;
    const exact = await apiRequest(cortexPort, "/v1/aggregates/resolve", readToken, {
      aggregationId: "proof-aggregate-0001",
      metric: "conversions",
      value: 12,
      traceKeys: [traceKey],
    });
    if (exact.status !== 200 || exact.body?.mode !== "ACTIVE" || exact.body?.result?.resolution !== "EXACT" || exact.body?.result?.creativeIds?.[0] !== creative.creativeId) {
      throw new Error(`CORTEX #16 exact attribution proof failed: ${JSON.stringify(exact)}`);
    }
    const incomplete = await apiRequest(cortexPort, "/v1/aggregates/resolve", readToken, {
      aggregationId: "proof-aggregate-0002",
      metric: "conversions",
      value: 19,
      traceKeys: [traceKey, "unknown-trace-0001"],
    });
    if (incomplete.status !== 200 || incomplete.body?.result?.resolution !== "INCOMPLETE_SET" || incomplete.body?.result?.resolvedTraceCount !== 1 || incomplete.body?.result?.unresolvedTraceCount !== 1) {
      throw new Error(`CORTEX #16 incomplete-set proof failed: ${JSON.stringify(incomplete)}`);
    }

    const observed = setMode(databasePath, "OBSERVE_ONLY", 1);
    if (observed.mode !== "OBSERVE_ONLY" || observed.revision !== 2) throw new Error("CORTEX #16 OBSERVE_ONLY transition failed");
    const blocked = await apiRequest(cortexPort, "/v1/creatives/register", writeToken, { ...creative, version: "proof-version-0002" });
    if (blocked.status !== 503) throw new Error("CORTEX #16 OBSERVE_ONLY did not block creative mutation");
    const observedResolve = await apiRequest(cortexPort, "/v1/aggregates/resolve", readToken, {
      aggregationId: "proof-aggregate-0003",
      metric: "conversions",
      value: 12,
      traceKeys: [traceKey],
    });
    if (observedResolve.status !== 200 || observedResolve.body?.mode !== "OBSERVE_ONLY" || observedResolve.body?.result?.resolution !== "EXACT") throw new Error("CORTEX #16 OBSERVE_ONLY did not preserve read-only resolution");

    const killed = setMode(databasePath, "KILLED", 2);
    if (killed.mode !== "KILLED" || killed.revision !== 3) throw new Error("CORTEX #16 KILLED transition failed");
    await waitHealth(runtime, cortexPort, 503);
    const killedResolve = await apiRequest(cortexPort, "/v1/aggregates/resolve", readToken, {
      aggregationId: "proof-aggregate-0004",
      metric: "conversions",
      value: 1,
      traceKeys: [traceKey],
    });
    if (killedResolve.status !== 503) throw new Error("CORTEX #16 KILLED did not close the attribution boundary");

    await stopRuntime(runtime);
    runtime = undefined;
    runtime = startRuntime(env);
    await waitHealth(runtime, cortexPort, 503);

    process.stdout.write(`${JSON.stringify({
      component: "cortex-16-runtime-proof",
      sourceSha: expectedSha,
      artifactDigest,
      durableRegistry: true,
      exactResolution: "EXACT",
      incompleteResolution: "INCOMPLETE_SET",
      rollback: "OBSERVE_ONLY_WRITE_BLOCKED_AND_KILLED_PERSISTED",
      probe: "pipeline-probe-isolated",
    })}\n`);
  } finally {
    await stopRuntime(runtime);
    rmSync(proofDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
