import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stageBuildArtifact } from "./artifact-identity-core.mjs";
import { buildTargets, clearOutputs, runTargetBuild, snapshotOutputs, sourceDateEpoch } from "./build-core.mjs";

const root = process.cwd();
for (const required of ["pnpm-lock.yaml", "runtime/Cargo.lock"]) if (!existsSync(join(root, required))) throw new Error(`required frozen lockfile missing: ${required}`);
const targets = buildTargets(root);
if (!targets.length) throw new Error("no build targets discovered");
for (const target of targets) clearOutputs(target.dir);
for (const target of targets) runTargetBuild(target, root);
const snapshot = snapshotOutputs(targets, root);
if (!snapshot.files.length) throw new Error("build produced no recognized output files");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const manifest = stageBuildArtifact({
  root,
  files: snapshot.files,
  artifactRoot: join(root, ".artifacts", "web-build"),
  manifestPath: join(root, ".artifacts", "web-build-identity.json"),
  identity: { sourceRevision, sourceDateEpoch: sourceDateEpoch(), nodeVersion: process.version, packageManager: rootManifest.packageManager, engineVersion: rootManifest.version },
});
console.log(JSON.stringify({ verdict: "PASS", authority: manifest.authority, sourceRevision, artifactDigest: manifest.artifactDigest, fileCount: manifest.fileCount, artifactRoot: ".artifacts/web-build", manifest: ".artifacts/web-build-identity.json" }, null, 2));
