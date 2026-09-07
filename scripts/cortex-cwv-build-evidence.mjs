#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_POLICY_BYTES = 256 * 1024;
const APP_ROOT = resolve(process.cwd());
const REPO_ROOT = resolve(APP_ROOT, "../..");
const ARTIFACT_DIR = join(APP_ROOT, ".nexus");
const PREBUILD_PATH = join(ARTIFACT_DIR, "cortex33-prebuild.json");
const CERT_PATH = join(ARTIFACT_DIR, "cortex33-build-certification.json");

function fail(message) { throw new Error(`CORTEX #33 build evidence: ${message}`); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function sha(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function required(name) { const value = process.env[name]?.trim(); if (!value) fail(`${name} is required`); return value; }
function jsonFile(path, label) {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_POLICY_BYTES) fail(`${label} must be a regular file of 1..${MAX_POLICY_BYTES} bytes`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail(`${label} contains malformed JSON`); }
}
function plain(value, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`); return value; }
function positive(value, label, max) { if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(`${label} must be 1..${max}`); return value; }
function buildPolicy(value) {
  const raw = plain(value, "build policy");
  if (Object.keys(raw).sort().join(",") !== "maxCssFileBytes,maxJsChunkBytes,maxStaticAssetBytes,maxTotalCssBytes,maxTotalJsBytes,version" || raw.version !== 1) fail("build policy contract/version is invalid");
  return Object.freeze({
    version: 1,
    maxJsChunkBytes: positive(raw.maxJsChunkBytes, "maxJsChunkBytes", 50_000_000),
    maxCssFileBytes: positive(raw.maxCssFileBytes, "maxCssFileBytes", 10_000_000),
    maxStaticAssetBytes: positive(raw.maxStaticAssetBytes, "maxStaticAssetBytes", 100_000_000),
    maxTotalJsBytes: positive(raw.maxTotalJsBytes, "maxTotalJsBytes", 500_000_000),
    maxTotalCssBytes: positive(raw.maxTotalCssBytes, "maxTotalCssBytes", 100_000_000),
  });
}
function edgePolicy(value) {
  const raw = plain(value, "edge policy");
  if (Object.keys(raw).sort().join(",") !== "mode,policyId,routes,version" || raw.version !== 1) fail("edge policy contract/version is invalid");
  if (!(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED")) fail("edge policy mode is invalid");
  if (typeof raw.policyId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u.test(raw.policyId.trim())) fail("edge policyId is invalid");
  if (!Array.isArray(raw.routes) || raw.routes.length < 1 || raw.routes.length > 128) fail("edge routes must contain 1..128 items");
  return raw;
}
function filesUnder(root, predicate = () => true) {
  const output = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && predicate(full)) output.push(full);
    }
  };
  walk(root);
  return output;
}
function fileEvidence(files) {
  return files.map((path) => {
    const bytes = readFileSync(path);
    return Object.freeze({ path: relative(REPO_ROOT, path).replaceAll("\\", "/"), bytes: bytes.byteLength, digest: sha(bytes) });
  });
}
function prepare() {
  const sourceRevision = (process.env.NEXUS_SOURCE_REVISION ?? process.env.GITHUB_SHA ?? "").trim().toLowerCase();
  if (!SHA.test(sourceRevision)) fail("NEXUS_SOURCE_REVISION or GITHUB_SHA must be a 40-character commit SHA");
  const buildPolicyValue = buildPolicy(jsonFile(required("NEXUS_CORTEX_33_BUILD_POLICY_FILE"), "NEXUS_CORTEX_33_BUILD_POLICY_FILE"));
  const edgePolicyValue = edgePolicy(jsonFile(required("NEXUS_CORTEX_33_EDGE_POLICY_FILE"), "NEXUS_CORTEX_33_EDGE_POLICY_FILE"));
  const roots = [join(APP_ROOT, "src"), join(APP_ROOT, "public")].filter((path) => { try { return statSync(path).isDirectory(); } catch { return false; } });
  const files = roots.flatMap((root) => filesUnder(root));
  for (const path of [join(APP_ROOT, "package.json"), join(APP_ROOT, "next.config.ts"), join(REPO_ROOT, "packages/core/cortex/cwv-lifecycle-optimizer/index.ts"), join(REPO_ROOT, "packages/core/cortex/cwv-lifecycle-pipeline/index.ts")]) files.push(path);
  const inputs = fileEvidence([...new Set(files)].sort());
  const base = {
    formatVersion: 1,
    sourceRevision,
    app: "apps/pipeline-probe",
    inputDigest: sha(canonical(inputs)),
    buildPolicyDigest: sha(canonical(buildPolicyValue)),
    edgePolicyDigest: sha(canonical(edgePolicyValue)),
    buildPolicy: buildPolicyValue,
    edgePolicy: edgePolicyValue,
  };
  const artifact = Object.freeze({ ...base, prebuildDigest: sha(canonical(base)) });
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(PREBUILD_PATH, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ component: "cortex-33-build", operation: "PREPARE", prebuildDigest: artifact.prebuildDigest, inputFiles: inputs.length })}\n`);
}
function certify() {
  const prebuild = jsonFile(PREBUILD_PATH, "CORTEX #33 prebuild artifact");
  const base = { formatVersion: prebuild.formatVersion, sourceRevision: prebuild.sourceRevision, app: prebuild.app, inputDigest: prebuild.inputDigest, buildPolicyDigest: prebuild.buildPolicyDigest, edgePolicyDigest: prebuild.edgePolicyDigest, buildPolicy: prebuild.buildPolicy, edgePolicy: prebuild.edgePolicy };
  if (prebuild.prebuildDigest !== sha(canonical(base))) fail("prebuild artifact digest mismatch");
  const policy = buildPolicy(prebuild.buildPolicy);
  const staticRoot = join(APP_ROOT, ".next", "static");
  if (!statSync(staticRoot).isDirectory()) fail(".next/static is missing after build");
  const files = fileEvidence(filesUnder(staticRoot));
  const js = files.filter((entry) => extname(entry.path) === ".js");
  const css = files.filter((entry) => extname(entry.path) === ".css");
  const totalJsBytes = js.reduce((sum, entry) => sum + entry.bytes, 0);
  const totalCssBytes = css.reduce((sum, entry) => sum + entry.bytes, 0);
  const overJs = js.find((entry) => entry.bytes > policy.maxJsChunkBytes);
  const overCss = css.find((entry) => entry.bytes > policy.maxCssFileBytes);
  const overStatic = files.find((entry) => entry.bytes > policy.maxStaticAssetBytes);
  if (overJs) fail(`JS chunk ${overJs.path} exceeds maxJsChunkBytes`);
  if (overCss) fail(`CSS file ${overCss.path} exceeds maxCssFileBytes`);
  if (overStatic) fail(`static asset ${overStatic.path} exceeds maxStaticAssetBytes`);
  if (totalJsBytes > policy.maxTotalJsBytes) fail(`total JS ${totalJsBytes} exceeds maxTotalJsBytes`);
  if (totalCssBytes > policy.maxTotalCssBytes) fail(`total CSS ${totalCssBytes} exceeds maxTotalCssBytes`);
  const outputDigest = sha(canonical(files));
  const evidence = { jsFiles: js.length, cssFiles: css.length, staticFiles: files.length, totalJsBytes, totalCssBytes, maxObservedJsChunkBytes: Math.max(0, ...js.map((entry) => entry.bytes)), maxObservedCssFileBytes: Math.max(0, ...css.map((entry) => entry.bytes)) };
  const certBase = { formatVersion: 1, sourceRevision: prebuild.sourceRevision, app: prebuild.app, prebuildDigest: prebuild.prebuildDigest, inputDigest: prebuild.inputDigest, buildPolicyDigest: prebuild.buildPolicyDigest, edgePolicyDigest: prebuild.edgePolicyDigest, outputDigest, evidence };
  const certification = Object.freeze({ ...certBase, certificationDigest: sha(canonical(certBase)) });
  writeFileSync(CERT_PATH, `${JSON.stringify(certification, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ component: "cortex-33-build", operation: "CERTIFY", certificationDigest: certification.certificationDigest, outputDigest, ...evidence })}\n`);
}

const command = process.argv[2];
if (command === "prepare") prepare();
else if (command === "certify") certify();
else fail("usage: cortex-cwv-build-evidence.mjs <prepare|certify>");
