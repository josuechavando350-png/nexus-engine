#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA1 = /^[a-f0-9]{40}$/;
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BROWSER_CAPTURES = Object.freeze([
  ["mobile-390.png", 390],
  ["tablet-768.png", 768],
  ["desktop-1440.png", 1440],
]);
const REQUIRED_SECURITY_HEADERS = Object.freeze([
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-frame-options", "SAMEORIGIN"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
]);
const REQUIRED_CSP_DIRECTIVES = Object.freeze({
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "frame-ancestors": ["'self'"],
  "object-src": ["'none'"],
});

const normalizePath = (path) => path.split(sep).join("/");
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function filesRecursively(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function collectArtifactHashes(repositoryRoot, buildDirectory) {
  const metadata = await stat(buildDirectory).catch(() => null);
  if (!metadata?.isDirectory()) throw new Error(`app build output does not exist: ${normalizePath(relative(repositoryRoot, buildDirectory))}`);
  const files = await filesRecursively(buildDirectory);
  if (!files.length) throw new Error(`app build output contains no files: ${normalizePath(relative(repositoryRoot, buildDirectory))}`);

  return Object.fromEntries(await Promise.all(files.map(async (path) => [
    normalizePath(relative(repositoryRoot, path)),
    createHash("sha256").update(await readFile(path)).digest("hex"),
  ])));
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function evidenceId(repositoryRoot, path) {
  return `file:${normalizePath(relative(repositoryRoot, path))}:sha256:${await sha256File(path)}`;
}

async function runGate({ id, command, args, repositoryRoot, evidenceDirectory }) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8", env: process.env });
  const logPath = join(evidenceDirectory, `${id}.log`);
  const output = [
    `$ ${[command, ...args].join(" ")}`,
    `exitCode=${result.status ?? "null"}`,
    result.stdout ?? "",
    result.stderr ?? "",
    result.error ? String(result.error) : "",
  ].filter(Boolean).join("\n");
  await writeFile(logPath, `${output.trim()}\n`, "utf8");
  const passed = result.status === 0;
  return Object.freeze({
    id,
    status: passed ? "PASS" : "FAIL",
    detail: passed ? `${id} command exited successfully` : `${id} command exited with code ${result.status ?? "unknown"}`,
    evidenceIds: Object.freeze([await evidenceId(repositoryRoot, logPath)]),
  });
}

export async function inspectBrowserCapture(repositoryRoot, projectId) {
  const captureRoot = join(repositoryRoot, "artifacts", "browser-capture", projectId);
  const files = await Promise.all(BROWSER_CAPTURES.map(async ([name, width]) => {
    const path = join(captureRoot, name);
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) return null;
    const png = bytes.length >= 24 && bytes.subarray(1, 4).toString("ascii") === "PNG";
    return { path, expectedWidth: width, actualWidth: png ? bytes.readUInt32BE(16) : null };
  }));
  if (files.some((file) => file === null)) return null;
  const captures = files.filter(Boolean);
  const passed = captures.every((capture) => capture.actualWidth === capture.expectedWidth);
  return Object.freeze({
    id: "browser-capture",
    status: passed ? "PASS" : "FAIL",
    detail: passed ? "verified CANO browser captures at widths 390, 768 and 1440" : "browser capture PNG dimensions do not match the required widths",
    evidenceIds: Object.freeze(await Promise.all(captures.map((capture) => evidenceId(repositoryRoot, capture.path)))),
  });
}

export async function inspectOperability(repositoryRoot, sourceRevision) {
  const path = join(repositoryRoot, ".artifacts", "h07-operability-proof.json");
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return null;
  const proof = JSON.parse(bytes.toString("utf8"));
  const passed = proof.commit === sourceRevision && Array.isArray(proof.phases) && proof.phases.length > 0 && proof.phases.every((phase) => phase.status === "PASS");
  return Object.freeze({
    id: "operability-h07",
    status: passed ? "PASS" : "FAIL",
    detail: passed ? "H-07 evidence is bound to this revision and every recorded phase passed" : "H-07 evidence is stale or contains a non-passing phase",
    evidenceIds: Object.freeze([await evidenceId(repositoryRoot, path)]),
  });
}

function parseCsp(value) {
  const directives = new Map();
  for (const rawDirective of value.split(";")) {
    const tokens = rawDirective.trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length) continue;
    const [name, ...sources] = tokens;
    directives.set(name.toLowerCase(), new Set(sources));
  }
  return directives;
}

export async function inspectSecurityHeaders(repositoryRoot, sourceRevision, url, evidenceDirectory) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const observedHeaders = Object.fromEntries([
    ...REQUIRED_SECURITY_HEADERS.map(([name]) => [name, response.headers.get(name)]),
    ["content-security-policy", response.headers.get("content-security-policy")],
  ]);
  const failures = [];

  if (response.status < 200 || response.status >= 400) failures.push(`unexpected HTTP status ${response.status}`);
  for (const [name, expected] of REQUIRED_SECURITY_HEADERS) {
    const actual = response.headers.get(name);
    if (actual !== expected) failures.push(`${name} expected ${JSON.stringify(expected)} but observed ${JSON.stringify(actual)}`);
  }

  const cspValue = response.headers.get("content-security-policy");
  if (!cspValue) {
    failures.push("content-security-policy header missing");
  } else {
    const csp = parseCsp(cspValue);
    for (const [directive, requiredSources] of Object.entries(REQUIRED_CSP_DIRECTIVES)) {
      const observed = csp.get(directive);
      if (!observed) {
        failures.push(`CSP directive ${directive} missing`);
        continue;
      }
      for (const source of requiredSources) {
        if (!observed.has(source)) failures.push(`CSP directive ${directive} missing required source ${source}`);
      }
    }
  }

  const evidencePath = join(evidenceDirectory, "security-headers.json");
  await writeFile(evidencePath, `${JSON.stringify({
    authority: "NEXUS_HTTP_SECURITY_HEADERS_OBSERVATION_V1",
    sourceRevision,
    url,
    responseStatus: response.status,
    observedHeaders,
    requiredHeaders: Object.fromEntries(REQUIRED_SECURITY_HEADERS),
    requiredCspDirectives: REQUIRED_CSP_DIRECTIVES,
    failures,
  }, null, 2)}\n`, "utf8");

  const passed = failures.length === 0;
  return Object.freeze({
    id: "security-headers",
    status: passed ? "PASS" : "FAIL",
    detail: passed ? "observed required security headers and CSP on the live built app response" : failures.join("; "),
    evidenceIds: Object.freeze([await evidenceId(repositoryRoot, evidencePath)]),
  });
}

async function reserveTcpPort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("could not reserve a TCP port for live security-header inspection"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

async function stopServerProcess(serverProcess) {
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  serverProcess.kill("SIGTERM");
  const stopped = await Promise.race([
    once(serverProcess, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!stopped && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill("SIGKILL");
    await once(serverProcess, "exit").catch(() => undefined);
  }
}

async function inspectBuiltAppSecurityHeaders(repositoryRoot, appManifest, sourceRevision, evidenceDirectory) {
  if (typeof appManifest.scripts?.start !== "string" || !appManifest.scripts.start.trim()) {
    throw new Error(`${appManifest.name} has no start script; live HTTP security headers cannot be certified`);
  }

  const port = await reserveTcpPort();
  const url = `http://127.0.0.1:${port}/`;
  const serverProcess = spawn("pnpm", ["--filter", appManifest.name, "exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const record = (chunk) => {
    if (output.length < 128 * 1024) output += chunk.toString();
  };
  serverProcess.stdout?.on("data", record);
  serverProcess.stderr?.on("data", record);

  try {
    const deadline = Date.now() + 30_000;
    let lastError = null;
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
        throw new Error(`built app server exited before HTTP inspection: ${output.trim().slice(-4000)}`);
      }
      try {
        const probe = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
        await probe.body?.cancel();
        if (probe.status >= 100) return await inspectSecurityHeaders(repositoryRoot, sourceRevision, url, evidenceDirectory);
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    throw new Error(`built app server did not become reachable at ${url}`, { cause: lastError });
  } finally {
    await stopServerProcess(serverProcess);
  }
}

async function loadQualityPassportContract(repositoryRoot) {
  const compiledContract = join(repositoryRoot, "packages", "quality", "dist", "quality", "quality-passport.js");
  execFileSync("pnpm", ["--filter", "@nexus/quality", "build"], { cwd: repositoryRoot, stdio: "inherit" });
  return import(pathToFileURL(compiledContract).href);
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const projectId = process.env.NEXUS_PROJECT_ID?.trim();
  if (!projectId) throw new Error("NEXUS_PROJECT_ID is required");
  if (!PROJECT_ID.test(projectId)) throw new Error("NEXUS_PROJECT_ID must be a kebab-case monorepo app id");

  const appRoot = join(repositoryRoot, "apps", projectId);
  const appManifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
  if (!appManifest.private) throw new Error(`apps/${projectId} must be a private monorepo app`);

  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (!SHA1.test(sourceRevision)) throw new Error("git rev-parse HEAD must return 40 lowercase hexadecimal characters");

  const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (typeof rootManifest.version !== "string" || !rootManifest.version.trim()) throw new Error("root package.json requires a version");

  const outputDirectory = join(appRoot, ".next");
  const evidenceDirectory = join(repositoryRoot, ".artifacts", "quality-passports", "evidence", projectId);
  await rm(evidenceDirectory, { recursive: true, force: true });
  await mkdir(evidenceDirectory, { recursive: true });

  // Hand-authored client Experiences do not run the generative pipeline, so its
  // content/generation/emitter/judge/red-team gates are intentionally excluded.
  const checks = [];
  checks.push(await runGate({ id: "lint", command: "pnpm", args: ["exec", "eslint", normalizePath(relative(repositoryRoot, join(appRoot, "src"))), normalizePath(relative(repositoryRoot, join(appRoot, "next.config.ts"))), normalizePath(relative(repositoryRoot, join(appRoot, "redirects.ts")))], repositoryRoot, evidenceDirectory }));
  checks.push(await runGate({ id: "typecheck", command: "pnpm", args: ["--filter", appManifest.name, "typecheck"], repositoryRoot, evidenceDirectory }));
  checks.push(await runGate({ id: "tests", command: "pnpm", args: ["test"], repositoryRoot, evidenceDirectory }));
  checks.push(await runGate({ id: "declared-assets", command: "pnpm", args: ["verify:assets"], repositoryRoot, evidenceDirectory }));

  await rm(outputDirectory, { recursive: true, force: true });
  const buildCheck = await runGate({ id: "build", command: "pnpm", args: ["--filter", appManifest.name, "build"], repositoryRoot, evidenceDirectory });
  checks.unshift(buildCheck);
  if (buildCheck.status !== "PASS") throw new Error("cannot create a Passport from a failed app build");

  checks.push(await inspectBuiltAppSecurityHeaders(repositoryRoot, appManifest, sourceRevision, evidenceDirectory));

  const browserCapture = await inspectBrowserCapture(repositoryRoot, projectId);
  if (browserCapture) checks.push(browserCapture);
  const operability = await inspectOperability(repositoryRoot, sourceRevision);
  if (operability) checks.push(operability);

  const artifactHashes = await collectArtifactHashes(repositoryRoot, outputDirectory);
  const { createQualityPassport, verifyQualityPassport } = await loadQualityPassportContract(repositoryRoot);
  const passport = createQualityPassport({
    projectId,
    engineVersion: rootManifest.version,
    sourceRevision,
    generatedAt: new Date().toISOString(),
    // Quality Passport V1 accepts one viewport; multi-viewport passports remain pending.
    viewport: { width: 1440, height: 1200 },
    artifactHashes,
    checks,
  });

  if (!verifyQualityPassport(passport)) throw new Error("generated Quality Passport failed integrity verification");

  const outputPath = join(repositoryRoot, ".artifacts", "quality-passports", `${projectId}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(passport, null, 2)}\n`, "utf8");
  process.stdout.write(`${normalizePath(relative(repositoryRoot, outputPath))}\n`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => { console.error(error); process.exitCode = 1; });
