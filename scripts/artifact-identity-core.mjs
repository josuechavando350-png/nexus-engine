import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { canonicalizeDeterministicBuildFile, NEXT_PREVIEW_MODE_EXCEPTION } from "./deterministic-build-canonicalization.mjs";
import { normalizedPath, walkFiles } from "./build-core.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestEntries = (entries) => {
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(entry.path); digest.update("\0"); digest.update(String(entry.size)); digest.update("\0"); digest.update(entry.sha256); digest.update("\0");
  }
  return digest.digest("hex");
};

export function stageBuildArtifact({ root, files, artifactRoot, manifestPath, identity }) {
  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });
  const entries = [];
  const normalizedFiles = [...files].sort((a, b) => a.localeCompare(b, "en"));
  for (const path of normalizedFiles) {
    const bytes = readFileSync(join(root, path));
    const canonical = canonicalizeDeterministicBuildFile(path, bytes);
    const destination = join(artifactRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, path), destination, { preserveTimestamps: false });
    entries.push({ path, size: bytes.length, sha256: hash(bytes), semanticSize: canonical.bytes.length, semanticSha256: hash(canonical.bytes), declaredExceptions: canonical.exceptions });
  }
  const manifest = {
    schemaVersion: 1,
    authority: "NEXUS_BUILD_ARTIFACT_IDENTITY_V1",
    ...identity,
    artifactDigest: digestEntries(entries),
    fileCount: entries.length,
    declaredJsonNormalization: "recursive object-key ordering; array order, names, presence, types and values remain significant",
    declaredDeterminismException: NEXT_PREVIEW_MODE_EXCEPTION,
    exceptionObservedIn: entries.filter((entry) => entry.declaredExceptions.length).map((entry) => ({ path: entry.path, fields: entry.declaredExceptions })),
    files: entries,
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyStagedArtifact({ artifactRoot, manifestPath, expectedSourceRevision }) {
  if (!existsSync(manifestPath)) throw new Error(`artifact identity manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.authority !== "NEXUS_BUILD_ARTIFACT_IDENTITY_V1" || !Array.isArray(manifest.files)) throw new Error("invalid artifact identity manifest");
  if (expectedSourceRevision && manifest.sourceRevision !== expectedSourceRevision) throw new Error(`artifact source revision mismatch: ${manifest.sourceRevision} != ${expectedSourceRevision}`);
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || !entry.path || isAbsolute(entry.path) || entry.path.split("/").includes("..") || typeof entry.size !== "number" || typeof entry.sha256 !== "string") {
      throw new Error("invalid artifact identity manifest entry");
    }
  }
  const actualPaths = walkFiles(artifactRoot, { ignore: new Set(["node_modules", ".git"]) })
    .map((path) => normalizedPath(relative(artifactRoot, path)))
    .sort((a, b) => a.localeCompare(b, "en"));
  const expectedPaths = manifest.files.map((entry) => entry.path).sort((a, b) => a.localeCompare(b, "en"));
  if (new Set(expectedPaths).size !== expectedPaths.length) throw new Error("duplicate path in artifact identity manifest");
  const expectedSet = new Set(expectedPaths), actualSet = new Set(actualPaths);
  const added = actualPaths.filter((path) => !expectedSet.has(path));
  const removed = expectedPaths.filter((path) => !actualSet.has(path));
  const expectedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const modified = [];
  const semanticallyModified = [];
  const actualEntries = [];
  for (const path of actualPaths) {
    const bytes = readFileSync(join(artifactRoot, path));
    const entry = { path, size: bytes.length, sha256: hash(bytes) };
    actualEntries.push(entry);
    const expected = expectedByPath.get(path);
    if (expected && (expected.size !== entry.size || expected.sha256 !== entry.sha256)) modified.push({ path, expected: { size: expected.size, sha256: expected.sha256 }, actual: entry });
    if (expected) {
      const semantic = canonicalizeDeterministicBuildFile(path, bytes).bytes;
      const actualSemantic = { size: semantic.length, sha256: hash(semantic) };
      if (expected.semanticSize !== actualSemantic.size || expected.semanticSha256 !== actualSemantic.sha256) {
        semanticallyModified.push({ path, expected: { size: expected.semanticSize, sha256: expected.semanticSha256 }, actual: actualSemantic });
      }
    }
  }
  const actualDigest = digestEntries(actualEntries);
  if (added.length || removed.length || modified.length || semanticallyModified.length || actualDigest !== manifest.artifactDigest) {
    const report = { verdict: "FAIL", authority: manifest.authority, reason: "ARTIFACT_IDENTITY_MISMATCH", expectedDigest: manifest.artifactDigest, actualDigest, added, removed, modified, semanticallyModified };
    throw Object.assign(new Error(JSON.stringify(report, null, 2)), { report });
  }
  return { verdict: "PASS", authority: manifest.authority, sourceRevision: manifest.sourceRevision, artifactDigest: actualDigest, fileCount: actualEntries.length };
}
