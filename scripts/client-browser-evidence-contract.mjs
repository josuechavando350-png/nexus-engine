import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const REQUIRED_CLIENT_BROWSER_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "mobile-390", width: 390, height: 844 }),
  Object.freeze({ name: "tablet-768", width: 768, height: 1024 }),
  Object.freeze({ name: "desktop-1440", width: 1440, height: 1200 }),
]);

const normalizePath = (path) => path.split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function canonicalWithoutSeal(value) {
  const { manifestSha256: _manifestSha256, ...payload } = value;
  void _manifestSha256;
  return JSON.stringify(payload);
}

function canonicalBuildPayload(manifest) {
  const { manifestSha256: _manifestSha256, ...payload } = manifest;
  void _manifestSha256;
  return JSON.stringify(payload);
}

export function sealClientBrowserEvidence(payload) {
  return Object.freeze({
    ...payload,
    manifestSha256: sha256(Buffer.from(JSON.stringify(payload), "utf8")),
  });
}

export function verifyClientBrowserEvidenceSeal(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  if (!SHA256.test(manifest.manifestSha256 ?? "")) return false;
  return sha256(Buffer.from(canonicalWithoutSeal(manifest), "utf8")) === manifest.manifestSha256;
}

async function confinedRegularFile(root, candidate, label) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  if (candidateAbsolute !== rootAbsolute && !candidateAbsolute.startsWith(`${rootAbsolute}${sep}`)) {
    throw new Error(`${label} must stay inside ${normalizePath(rootAbsolute)}`);
  }
  const metadata = await lstat(candidateAbsolute).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const [rootReal, fileReal] = await Promise.all([realpath(rootAbsolute), realpath(candidateAbsolute)]);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) throw new Error(`${label} resolves outside its evidence root`);
  return fileReal;
}

export function parsePngDimensions(bytes, label = "PNG") {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${label} is not a valid PNG header`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error(`${label} has invalid PNG dimensions`);
  return Object.freeze({ width, height });
}

function verifyBuildManifest(buildManifest, evidence, projectId, sourceRevision) {
  if (!buildManifest || typeof buildManifest !== "object" || Array.isArray(buildManifest)) throw new Error("browser evidence build manifest must be an object");
  if (buildManifest.authority !== "NEXUS_MCP_BUILD_MANIFEST_V1") throw new Error("browser evidence build manifest has the wrong authority");
  if (buildManifest.sourceSha !== sourceRevision) throw new Error("browser evidence build manifest is bound to a different source revision");
  if (buildManifest.target !== `apps/${projectId}`) throw new Error("browser evidence build manifest is bound to a different project target");
  if (!SHA256.test(buildManifest.manifestSha256 ?? "") || sha256(Buffer.from(canonicalBuildPayload(buildManifest), "utf8")) !== buildManifest.manifestSha256) {
    throw new Error("browser evidence build manifest failed its integrity seal");
  }
  if (evidence.build?.authority !== buildManifest.authority
    || evidence.build?.target !== buildManifest.target
    || evidence.build?.manifestSha256 !== buildManifest.manifestSha256
    || evidence.build?.outputDigest !== buildManifest.outputDigest) {
    throw new Error("browser evidence does not match its persisted exact-SHA build manifest");
  }
  if (!SHA256.test(buildManifest.outputDigest ?? "")) throw new Error("browser evidence build output digest is invalid");
}

export async function inspectClientBrowserEvidence(repositoryRoot, projectId, sourceRevision) {
  if (!PROJECT_ID.test(projectId)) throw new Error("browser evidence projectId must be kebab-case");
  if (!SHA1.test(sourceRevision)) throw new Error("browser evidence sourceRevision must be a full lowercase Git SHA-1");
  const captureRoot = join(repositoryRoot, "artifacts", "browser-capture", projectId);
  const manifestPath = join(captureRoot, "evidence-manifest.json");
  const manifestMetadata = await stat(manifestPath).catch(() => null);
  if (!manifestMetadata) {
    const captureRootMetadata = await stat(captureRoot).catch(() => null);
    if (captureRootMetadata?.isDirectory()) throw new Error(`browser evidence directory exists without ${normalizePath(relative(repositoryRoot, manifestPath))}`);
    return null;
  }

  const manifestReal = await confinedRegularFile(captureRoot, manifestPath, "browser evidence manifest");
  const manifestBytes = await readFile(manifestReal);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.authority !== "NEXUS_CLIENT_BROWSER_EVIDENCE_V1") throw new Error("browser evidence manifest has an unsupported schema or authority");
  if (!verifyClientBrowserEvidenceSeal(manifest)) throw new Error("browser evidence manifest failed its integrity seal");
  if (manifest.projectId !== projectId) throw new Error(`browser evidence project ${manifest.projectId ?? "missing"} does not match ${projectId}`);
  if (manifest.sourceRevision !== sourceRevision) throw new Error("browser evidence is stale for the current source revision");
  if (manifest.route !== "/") throw new Error("browser evidence must be captured from the canonical root route");
  if (typeof manifest.requestId !== "string" || !manifest.requestId.trim() || typeof manifest.runId !== "string" || !manifest.runId.trim()) {
    throw new Error("browser evidence is missing capture request/run identity");
  }

  if (typeof manifest.build?.manifestPath !== "string" || !manifest.build.manifestPath.trim()) throw new Error("browser evidence is missing its build manifest path");
  const buildManifestPath = resolve(repositoryRoot, manifest.build.manifestPath);
  const buildManifestReal = await confinedRegularFile(captureRoot, buildManifestPath, "browser evidence build manifest");
  const buildManifest = JSON.parse((await readFile(buildManifestReal)).toString("utf8"));
  verifyBuildManifest(buildManifest, manifest, projectId, sourceRevision);

  if (!Array.isArray(manifest.captures) || manifest.captures.length !== REQUIRED_CLIENT_BROWSER_VIEWPORTS.length) {
    throw new Error(`browser evidence requires exactly ${REQUIRED_CLIENT_BROWSER_VIEWPORTS.length} screenshots`);
  }

  const evidenceIds = [
    `file:${normalizePath(relative(repositoryRoot, manifestReal))}:sha256:${sha256(manifestBytes)}`,
    `file:${normalizePath(relative(repositoryRoot, buildManifestReal))}:sha256:${sha256(await readFile(buildManifestReal))}`,
  ];
  const seen = new Set();
  for (const expected of REQUIRED_CLIENT_BROWSER_VIEWPORTS) {
    const matches = manifest.captures.filter((capture) => capture?.browser === "chromium" && capture?.viewport === expected.name);
    if (matches.length !== 1) throw new Error(`browser evidence requires exactly one chromium capture for ${expected.name}`);
    const capture = matches[0];
    if (seen.has(capture.viewport)) throw new Error(`browser evidence duplicates viewport ${capture.viewport}`);
    seen.add(capture.viewport);
    if (capture.viewportWidth !== expected.width || capture.viewportHeight !== expected.height) {
      throw new Error(`browser evidence viewport metadata does not match ${expected.name}`);
    }
    if (typeof capture.path !== "string" || !capture.path.trim()) throw new Error(`browser evidence ${expected.name} is missing its file path`);
    const captureReal = await confinedRegularFile(captureRoot, resolve(repositoryRoot, capture.path), `browser evidence ${expected.name}`);
    const bytes = await readFile(captureReal);
    const dimensions = parsePngDimensions(bytes, `browser evidence ${expected.name}`);
    if (capture.imageWidth !== dimensions.width || capture.imageHeight !== dimensions.height) {
      throw new Error(`browser evidence image metadata does not match persisted PNG dimensions for ${expected.name}`);
    }
    if (dimensions.width !== expected.width) throw new Error(`browser evidence PNG width does not match viewport ${expected.name}`);
    if (dimensions.height < expected.height) throw new Error(`browser evidence full-page PNG is shorter than viewport ${expected.name}`);
    const digest = sha256(bytes);
    if (!SHA256.test(capture.sha256 ?? "") || capture.sha256 !== digest) throw new Error(`browser evidence ${expected.name} digest does not match persisted bytes`);
    if (capture.byteLength !== bytes.byteLength) throw new Error(`browser evidence ${expected.name} byte length does not match persisted bytes`);
    evidenceIds.push(`file:${normalizePath(relative(repositoryRoot, captureReal))}:sha256:${digest}`);
  }

  return Object.freeze({
    id: "browser-capture",
    status: "PASS",
    detail: `verified exact-SHA ${projectId} Chromium full-page browser evidence at 390, 768 and 1440 viewport widths against build ${manifest.build.outputDigest}`,
    evidenceIds: Object.freeze(evidenceIds),
  });
}
