import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTargets,
  clearOutputs,
  runTargetBuild,
  snapshotOutputs,
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

for (const target of targets) clearOutputs(target.dir);
for (const target of targets) runTargetBuild(target, root);
const first = snapshotOutputs(targets, root);

for (const target of targets) clearOutputs(target.dir);
for (const target of targets) runTargetBuild(target, root);
const second = snapshotOutputs(targets, root);

if (first.files.length === 0 || second.files.length === 0) throw new Error("determinism check produced no build output files");
if (JSON.stringify(first.files) !== JSON.stringify(second.files)) {
  throw new Error("build output file set is not deterministic");
}
if (first.digest !== second.digest) {
  throw new Error(`build bytes are not deterministic: ${first.digest} != ${second.digest}`);
}

const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(JSON.stringify({
  verdict: "PASS",
  authority: "NEXUS_HERMETIC_BUILD_V1",
  sourceRevision: currentCommit,
  sourceDateEpoch: epoch,
  engineVersion: rootManifest.version,
  outputDigest: first.digest,
  outputFileCount: first.files.length,
}, null, 2));
