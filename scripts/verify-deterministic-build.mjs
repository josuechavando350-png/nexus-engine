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

const stableJson = (value) => {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  return value;
};

const canonicalNextManifestBytes = (path, bytes) => {
  if (!path.includes("/.next/")) return bytes;
  const basename = path.split("/").at(-1);
  if (!["prerender-manifest.json", "server-reference-manifest.json", "pages-manifest.json"].includes(basename)) return bytes;

  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return bytes;
  }

  // Next.js intentionally generates per-build cryptographic material for
  // preview mode and Server Actions. Those values are security state, not
  // source-derived application bytes, so they must not be replaced with a
  // predictable constant merely to satisfy reproducibility checks. Instead,
  // canonicalize only those documented ephemeral fields while requiring every
  // other manifest byte/field to remain deterministic.
  if (basename === "prerender-manifest.json" && parsed.preview && typeof parsed.preview === "object") {
    for (const key of ["previewModeId", "previewModeSigningKey", "previewModeEncryptionKey"]) {
      if (key in parsed.preview) parsed.preview[key] = `<NEXUS_EPHEMERAL_${key}>`;
    }
  }

  if (basename === "server-reference-manifest.json" && parsed && typeof parsed === "object") {
    if ("encryptionKey" in parsed) parsed.encryptionKey = "<NEXUS_EPHEMERAL_SERVER_ACTIONS_KEY>";
  }

  // JSON object member order has no semantic meaning, but Next.js may emit
  // pages-manifest entries in different insertion order across otherwise
  // equivalent builds. Stable ordering keeps the gate strict on content.
  return Buffer.from(`${JSON.stringify(stableJson(parsed))}\n`, "utf8");
};

const fileEntries = (paths) => paths.map((path) => {
  const bytes = readFileSync(join(root, path));
  const canonicalBytes = canonicalNextManifestBytes(path, bytes);
  return {
    path,
    size: canonicalBytes.length,
    sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
    rawSize: bytes.length,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

const diffEntries = (firstEntries, secondEntries) => {
  const firstByPath = new Map(firstEntries.map((entry) => [entry.path, entry]));
  const secondByPath = new Map(secondEntries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])].sort((a, b) => a.localeCompare(b, "en"));
  const added = [];
  const removed = [];
  const modified = [];
  const rawOnlyDifferences = [];

  for (const path of allPaths) {
    const a = firstByPath.get(path);
    const b = secondByPath.get(path);
    if (!a) added.push(b);
    else if (!b) removed.push(a);
    else if (a.sha256 !== b.sha256 || a.size !== b.size) {
      modified.push({
        path,
        first: { size: a.size, sha256: a.sha256, rawSize: a.rawSize, rawSha256: a.rawSha256 },
        second: { size: b.size, sha256: b.sha256, rawSize: b.rawSize, rawSha256: b.rawSha256 },
      });
    } else if (a.rawSha256 !== b.rawSha256 || a.rawSize !== b.rawSize) {
      rawOnlyDifferences.push({
        path,
        first: { size: a.rawSize, sha256: a.rawSha256 },
        second: { size: b.rawSize, sha256: b.rawSha256 },
      });
    }
  }
  return { added, removed, modified, rawOnlyDifferences };
};

const digestCanonicalEntries = (entries) => {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const buildCleanSnapshot = () => {
  for (const target of targets) clearOutputs(target.dir);
  for (const target of targets) runTargetBuild(target, root);
  const perTarget = targets.map((target) => {
    const dirs = outputDirs(target.dir);
    if (!dirs.length) throw new Error(`build target produced no recognized output directory: ${target.relativeDir}`);
    const snapshot = snapshotTargetOutputs(target, root);
    if (!snapshot.files.length) throw new Error(`build target produced no output files: ${target.relativeDir}`);
    const entries = fileEntries(snapshot.files);
    return { target: target.relativeDir, ...snapshot, canonicalDigest: digestCanonicalEntries(entries), entries };
  });
  const workspace = snapshotOutputs(targets, root);
  const entries = fileEntries(workspace.files);
  return { workspace: { ...workspace, canonicalDigest: digestCanonicalEntries(entries), entries }, perTarget };
};

const first = buildCleanSnapshot();
const second = buildCleanSnapshot();

const workspaceDiff = diffEntries(first.workspace.entries, second.workspace.entries);
const hasWorkspaceDiff = workspaceDiff.added.length > 0 || workspaceDiff.removed.length > 0 || workspaceDiff.modified.length > 0;
if (hasWorkspaceDiff) {
  console.error(JSON.stringify({
    verdict: "FAIL",
    authority: "NEXUS_HERMETIC_BUILD_V2",
    reason: "NONDETERMINISTIC_SOURCE_DERIVED_OUTPUTS",
    firstDigest: first.workspace.canonicalDigest,
    secondDigest: second.workspace.canonicalDigest,
    diff: workspaceDiff,
  }, null, 2));
  throw new Error("source-derived build outputs are not deterministic; exact canonical diff emitted above");
}

if (JSON.stringify(first.workspace.files) !== JSON.stringify(second.workspace.files)) {
  throw new Error("build output file set is not deterministic");
}
if (first.workspace.canonicalDigest !== second.workspace.canonicalDigest) {
  throw new Error(`canonical build bytes are not deterministic: ${first.workspace.canonicalDigest} != ${second.workspace.canonicalDigest}`);
}
for (let index = 0; index < first.perTarget.length; index += 1) {
  const a = first.perTarget[index];
  const b = second.perTarget[index];
  if (a.target !== b.target || a.canonicalDigest !== b.canonicalDigest || JSON.stringify(a.files) !== JSON.stringify(b.files)) {
    const targetDiff = diffEntries(a.entries, b.entries);
    console.error(JSON.stringify({ target: a.target, diff: targetDiff }, null, 2));
    throw new Error(`build target is not deterministic after approved framework-ephemeral canonicalization: ${a.target}`);
  }
}

const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
console.log(JSON.stringify({
  verdict: "PASS",
  authority: "NEXUS_HERMETIC_BUILD_V2",
  sourceRevision: currentCommit,
  sourceDateEpoch: epoch,
  engineVersion: rootManifest.version,
  outputDigest: first.workspace.canonicalDigest,
  rawFrameworkEphemeralDifferences: workspaceDiff.rawOnlyDifferences.map((entry) => entry.path),
  outputFileCount: first.workspace.files.length,
  targets: first.perTarget.map((snapshot) => ({
    target: snapshot.target,
    digest: snapshot.canonicalDigest,
    files: snapshot.files,
  })),
}, null, 2));
