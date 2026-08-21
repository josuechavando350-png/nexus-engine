import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTargets,
  clearOutputs,
  outputDirs,
  runTargetBuild,
  snapshotOutputs,
  snapshotTargetOutputs,
  sourceDateEpoch,
} from "./build-core.mjs";

const root = process.cwd();
for (const required of ["pnpm-lock.yaml", "runtime/Cargo.lock"]) {
  if (!existsSync(join(root, required))) throw new Error(`required frozen lockfile missing: ${required}`);
}

const epoch = sourceDateEpoch(root);
if (!/^\d+$/.test(epoch)) throw new Error(`invalid SOURCE_DATE_EPOCH: ${epoch}`);
process.env.SOURCE_DATE_EPOCH = epoch;

const targets = buildTargets(root);
if (!targets.length) throw new Error("no build targets discovered");

const fileEntries = (paths) => paths.map((path) => {
  const bytes = readFileSync(join(root, path));
  return {
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

const diffEntries = (firstEntries, secondEntries) => {
  const firstByPath = new Map(firstEntries.map((entry) => [entry.path, entry]));
  const secondByPath = new Map(secondEntries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])].sort((a, b) => a.localeCompare(b, "en"));
  const added = [];
  const removed = [];
  const modified = [];

  for (const path of allPaths) {
    const a = firstByPath.get(path);
    const b = secondByPath.get(path);
    if (!a) added.push(b);
    else if (!b) removed.push(a);
    else if (a.sha256 !== b.sha256 || a.size !== b.size) {
      modified.push({
        path,
        first: { size: a.size, sha256: a.sha256 },
        second: { size: b.size, sha256: b.sha256 },
      });
    }
  }
  return { added, removed, modified };
};

const buildCleanSnapshot = () => {
  for (const target of targets) clearOutputs(target.dir);
  for (const target of targets) runTargetBuild(target, root);
  const perTarget = targets.map((target) => {
    const dirs = outputDirs(target.dir);
    if (!dirs.length) throw new Error(`build target produced no recognized output directory: ${target.relativeDir}`);
    const snapshot = snapshotTargetOutputs(target, root);
    if (!snapshot.files.length) throw new Error(`build target produced no output files: ${target.relativeDir}`);
    return { target: target.relativeDir, ...snapshot, entries: fileEntries(snapshot.files) };
  });
  const workspace = snapshotOutputs(targets, root);
  return { workspace: { ...workspace, entries: fileEntries(workspace.files) }, perTarget };
};

const first = buildCleanSnapshot();
const second = buildCleanSnapshot();

const workspaceDiff = diffEntries(first.workspace.entries, second.workspace.entries);
const hasWorkspaceDiff = workspaceDiff.added.length > 0 || workspaceDiff.removed.length > 0 || workspaceDiff.modified.length > 0;
if (hasWorkspaceDiff) {
  console.error(JSON.stringify({
    verdict: "FAIL",
    authority: "NEXUS_HERMETIC_BUILD_V1",
    reason: "NONDETERMINISTIC_OUTPUTS",
    firstDigest: first.workspace.digest,
    secondDigest: second.workspace.digest,
    diff: workspaceDiff,
  }, null, 2));
  throw new Error("build outputs are not byte-deterministic; exact file diff emitted above");
}

if (JSON.stringify(first.workspace.files) !== JSON.stringify(second.workspace.files)) {
  throw new Error("build output file set is not deterministic");
}
if (first.workspace.digest !== second.workspace.digest) {
  throw new Error(`build bytes are not deterministic: ${first.workspace.digest} != ${second.workspace.digest}`);
}
for (let index = 0; index < first.perTarget.length; index += 1) {
  const a = first.perTarget[index];
  const b = second.perTarget[index];
  if (a.target !== b.target || a.digest !== b.digest || JSON.stringify(a.files) !== JSON.stringify(b.files)) {
    const targetDiff = diffEntries(a.entries, b.entries);
    console.error(JSON.stringify({ target: a.target, diff: targetDiff }, null, 2));
    throw new Error(`build target is not byte-deterministic: ${a.target}`);
  }
}

const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(JSON.stringify({
  verdict: "PASS",
  authority: "NEXUS_HERMETIC_BUILD_V1",
  sourceRevision: currentCommit,
  sourceDateEpoch: epoch,
  engineVersion: rootManifest.version,
  outputDigest: first.workspace.digest,
  outputFileCount: first.workspace.files.length,
  targets: first.perTarget.map(({ entries: _entries, ...target }) => target),
}, null, 2));
