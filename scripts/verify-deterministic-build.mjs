import { createHash } from "node:crypto";
// Optional diagnostic for build nondeterminism; this is not a validation gate.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTargets, clearOutputs, outputDirs, runTargetBuild, snapshotOutputs, snapshotTargetOutputs, sourceDateEpoch } from "./build-core.mjs";
import { canonicalizeDeterministicBuildFile, NEXT_PREVIEW_MODE_EXCEPTION } from "./deterministic-build-canonicalization.mjs";

const root = process.cwd();
for (const required of ["pnpm-lock.yaml", "runtime/Cargo.lock"]) {
  if (!existsSync(join(root, required))) throw new Error(`required frozen lockfile missing: ${required}`);
}
const epoch = sourceDateEpoch(root);
if (!/^\d+$/.test(epoch)) throw new Error(`invalid SOURCE_DATE_EPOCH: ${epoch}`);
process.env.SOURCE_DATE_EPOCH = epoch;
const targets = buildTargets(root);
if (!targets.length) throw new Error("no build targets discovered");

const fileEntries = (paths) => {
  return paths.map((rawPath) => {
    const bytes = readFileSync(join(root, rawPath));
    const canonical = canonicalizeDeterministicBuildFile(rawPath, bytes);
    return {
      path: rawPath,
      size: canonical.bytes.length,
      sha256: createHash("sha256").update(canonical.bytes).digest("hex"),
      rawPath,
      rawSize: bytes.length,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      declaredExceptions: canonical.exceptions,
    };
  });
};

const diffEntries = (firstEntries, secondEntries) => {
  const firstByPath = new Map(firstEntries.map((entry) => [entry.path, entry]));
  const secondByPath = new Map(secondEntries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])].sort((a, b) => a.localeCompare(b, "en"));
  const added = [], removed = [], modified = [], rawOnlyDifferences = [];
  for (const path of allPaths) {
    const a = firstByPath.get(path), b = secondByPath.get(path);
    if (!a) added.push(b);
    else if (!b) removed.push(a);
    else if (a.sha256 !== b.sha256 || a.size !== b.size) modified.push({ path, first: { size: a.size, sha256: a.sha256, rawSize: a.rawSize, rawSha256: a.rawSha256 }, second: { size: b.size, sha256: b.sha256, rawSize: b.rawSize, rawSha256: b.rawSha256 } });
    else if (a.rawSha256 !== b.rawSha256 || a.rawSize !== b.rawSize || a.rawPath !== b.rawPath) rawOnlyDifferences.push({ path, first: { path: a.rawPath, size: a.rawSize, sha256: a.rawSha256 }, second: { path: b.rawPath, size: b.rawSize, sha256: b.rawSha256 } });
  }
  return { added, removed, modified, rawOnlyDifferences };
};

const digestCanonicalEntries = (entries) => {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    hash.update(entry.path); hash.update("\0"); hash.update(String(entry.size)); hash.update("\0"); hash.update(entry.sha256); hash.update("\0");
  }
  return hash.digest("hex");
};
const canonicalFileSet = (entries) => entries.map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "en"));

const buildCleanSnapshot = () => {
  for (const target of targets) clearOutputs(target.dir);
  for (const target of targets) runTargetBuild(target, root);
  const perTarget = targets.map((target) => {
    const dirs = outputDirs(target.dir);
    if (!dirs.length) throw new Error(`build target produced no recognized output directory: ${target.relativeDir}`);
    const snapshot = snapshotTargetOutputs(target, root);
    if (!snapshot.files.length) throw new Error(`build target produced no output files: ${target.relativeDir}`);
    const entries = fileEntries(snapshot.files);
    return { target: target.relativeDir, ...snapshot, canonicalFiles: canonicalFileSet(entries), canonicalDigest: digestCanonicalEntries(entries), entries };
  });
  const workspace = snapshotOutputs(targets, root);
  const entries = fileEntries(workspace.files);
  return { workspace: { ...workspace, canonicalFiles: canonicalFileSet(entries), canonicalDigest: digestCanonicalEntries(entries), entries }, perTarget };
};

const first = buildCleanSnapshot(), second = buildCleanSnapshot();
const workspaceDiff = diffEntries(first.workspace.entries, second.workspace.entries);
if (workspaceDiff.added.length || workspaceDiff.removed.length || workspaceDiff.modified.length) {
  console.error(JSON.stringify({ verdict: "FAIL", authority: "NEXUS_HERMETIC_BUILD_V2", reason: "NONDETERMINISTIC_SOURCE_DERIVED_OUTPUTS", firstDigest: first.workspace.canonicalDigest, secondDigest: second.workspace.canonicalDigest, diff: workspaceDiff }, null, 2));
  throw new Error("source-derived build outputs are not deterministic; exact canonical diff emitted above");
}
if (JSON.stringify(first.workspace.canonicalFiles) !== JSON.stringify(second.workspace.canonicalFiles)) throw new Error("canonical build output file set is not deterministic");
if (first.workspace.canonicalDigest !== second.workspace.canonicalDigest) throw new Error(`canonical build bytes are not deterministic: ${first.workspace.canonicalDigest} != ${second.workspace.canonicalDigest}`);
for (let i = 0; i < first.perTarget.length; i += 1) {
  const a = first.perTarget[i], b = second.perTarget[i];
  if (a.target !== b.target || a.canonicalDigest !== b.canonicalDigest || JSON.stringify(a.canonicalFiles) !== JSON.stringify(b.canonicalFiles)) {
    console.error(JSON.stringify({ target: a.target, diff: diffEntries(a.entries, b.entries) }, null, 2));
    throw new Error(`build target is not deterministic after approved framework-ephemeral canonicalization: ${a.target}`);
  }
}
const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(JSON.stringify({ verdict: "PASS", authority: "NEXUS_HERMETIC_BUILD_V2", sourceRevision: currentCommit, sourceDateEpoch: epoch, engineVersion: rootManifest.version, outputDigest: first.workspace.canonicalDigest, declaredDeterminismException: NEXT_PREVIEW_MODE_EXCEPTION, exceptionObservedIn: workspaceDiff.rawOnlyDifferences.filter((entry) => entry.path.endsWith("/.next/prerender-manifest.json")).map((entry) => entry.path), outputFileCount: first.workspace.canonicalFiles.length, targets: first.perTarget.map((snapshot) => ({ target: snapshot.target, digest: snapshot.canonicalDigest, files: snapshot.canonicalFiles })) }, null, 2));
