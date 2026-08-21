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

const buildCleanSnapshot = () => {
  for (const target of targets) clearOutputs(target.dir);
  for (const target of targets) runTargetBuild(target, root);
  const perTarget = targets.map((target) => {
    const dirs = outputDirs(target.dir);
    if (!dirs.length) throw new Error(`build target produced no recognized output directory: ${target.relativeDir}`);
    const snapshot = snapshotTargetOutputs(target, root);
    if (!snapshot.files.length) throw new Error(`build target produced no output files: ${target.relativeDir}`);
    return { target: target.relativeDir, ...snapshot };
  });
  return { workspace: snapshotOutputs(targets, root), perTarget };
};

const first = buildCleanSnapshot();
const second = buildCleanSnapshot();

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
  targets: first.perTarget,
}, null, 2));
