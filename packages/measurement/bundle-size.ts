import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface BundleArtifactMeasurement {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundleSizeMeasurement {
  authority: "NEXUS_BUILD_ARTIFACT_BYTES_V1";
  root: string;
  fileCount: number;
  totalBytes: number;
  artifacts: readonly BundleArtifactMeasurement[];
  digest: string;
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function walk(root: string, directory: string, output: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`bundle measurement refuses symbolic link: ${absolute}`);
    if (entry.isDirectory()) await walk(root, absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
}

export async function measureBuildArtifacts(rootPath: string): Promise<BundleSizeMeasurement> {
  if (!rootPath.trim()) throw new Error("build artifact root is required");
  const root = resolve(rootPath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`build artifact root must be a directory: ${root}`);

  const files: string[] = [];
  await walk(root, root, files);
  if (!files.length) throw new Error(`build artifact root is empty: ${root}`);

  const artifacts: BundleArtifactMeasurement[] = [];
  let totalBytes = 0;
  for (const absolute of files) {
    const bytes = await readFile(absolute);
    const path = relative(root, absolute).split(sep).join("/");
    totalBytes += bytes.byteLength;
    artifacts.push(Object.freeze({ path, bytes: bytes.byteLength, sha256: sha256(bytes) }));
  }

  const canonical = artifacts.map((artifact) => `${artifact.path}\0${artifact.bytes}\0${artifact.sha256}`).join("\n");
  return Object.freeze({
    authority: "NEXUS_BUILD_ARTIFACT_BYTES_V1",
    root,
    fileCount: artifacts.length,
    totalBytes,
    artifacts: Object.freeze(artifacts),
    digest: sha256(canonical),
  });
}
