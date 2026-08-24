#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { buildTargets, restoreFromCache, runTargetBuild, snapshotTargetOutputs, storeInCache, targetBuildKey } from "./build-core.mjs";

const [targetRelativeDir, expectedSha, manifestOutput] = process.argv.slice(2);
if (!targetRelativeDir || !/^[a-f0-9]{40}$/.test(expectedSha ?? "") || !manifestOutput) throw new Error("usage: build-target-manifest.mjs <target-relative-dir> <source-sha> <manifest-output>");
const root = process.cwd();
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (headSha !== expectedSha) throw new Error(`source SHA mismatch: expected ${expectedSha}, current ${headSha}`);
const worktree = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (worktree) throw new Error("target build requires a clean worktree");
const target = buildTargets(root).find((candidate) => candidate.relativeDir === targetRelativeDir);
if (!target) throw new Error(`build target not found: ${targetRelativeDir}`);
const buildKey = targetBuildKey(target, root);
const cacheHit = restoreFromCache(target, buildKey, root);
if (!cacheHit) { runTargetBuild(target, root); storeInCache(target, buildKey, root); }
const snapshot = snapshotTargetOutputs(target, root);
if (!snapshot.files.length) throw new Error(`build target produced no artifacts: ${targetRelativeDir}`);
const files = snapshot.files.map((path) => {
  const bytes = readFileSync(join(root, path));
  return { path, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}).sort((left, right) => left.path.localeCompare(right.path, "en"));
const payload = { authority: "NEXUS_MCP_BUILD_MANIFEST_V1", sourceSha: headSha, target: targetRelativeDir, nodeVersion: process.version, pnpmVersion: execFileSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" }).trim(), packageManager: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager, lockfileSha256: createHash("sha256").update(readFileSync(join(root, "pnpm-lock.yaml"))).digest("hex"), buildKey, cacheHit, outputDigest: snapshot.digest, files };
const canonical = JSON.stringify(payload);
const manifest = { ...payload, manifestSha256: createHash("sha256").update(canonical).digest("hex") };
const output = resolve(manifestOutput);
const tempRoot = resolve(process.env.TMPDIR || "/tmp");
if (output !== tempRoot && !output.startsWith(`${tempRoot}${sep}`)) throw new Error("manifest output must be inside TMPDIR");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
