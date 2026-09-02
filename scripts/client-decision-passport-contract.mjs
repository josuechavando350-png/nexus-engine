import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const normalizePath = (path) => path.split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function confinedRegularFile(root, candidate, label) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  if (candidateAbsolute !== rootAbsolute && !candidateAbsolute.startsWith(`${rootAbsolute}${sep}`)) throw new Error(`${label} must stay inside ${normalizePath(rootAbsolute)}`);
  const metadata = await lstat(candidateAbsolute).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const [rootReal, fileReal] = await Promise.all([realpath(rootAbsolute), realpath(candidateAbsolute)]);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) throw new Error(`${label} resolves outside its evidence root`);
  return fileReal;
}

function canonicalStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${label} must be a non-empty string array`);
  const normalized = values.map((value) => value.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must contain unique values`);
  const sorted = [...normalized].sort((a, b) => a.localeCompare(b, "en"));
  if (JSON.stringify(normalized) !== JSON.stringify(sorted)) throw new Error(`${label} must be canonically sorted`);
  return sorted;
}

export async function inspectClientDecisionPassportEvidence(repositoryRoot, projectId, sourceRevision) {
  if (!PROJECT_ID.test(projectId)) throw new Error("decision passport projectId must be kebab-case");
  if (!SHA1.test(sourceRevision)) throw new Error("decision passport sourceRevision must be a full lowercase Git SHA-1");

  const decisionRoot = join(repositoryRoot, "artifacts", "decision-trace");
  const decisionPath = join(decisionRoot, `${projectId}.json`);
  const decisionMetadata = await stat(decisionPath).catch(() => null);
  if (!decisionMetadata) return null;
  const decisionReal = await confinedRegularFile(decisionRoot, decisionPath, "decision provenance packet");
  const decisionBytes = await readFile(decisionReal);
  const packet = JSON.parse(decisionBytes.toString("utf8"));

  if (packet.schemaVersion !== 2 || packet.authority !== "NEXUS_CLIENT_DECISION_PROVENANCE_V2") throw new Error("decision provenance packet has an unsupported schema or authority");
  if (packet.projectId !== projectId) throw new Error("decision provenance packet is bound to a different project");
  if (packet.sourceRevision !== sourceRevision) throw new Error("decision provenance packet is stale for the current source revision");
  if (packet.route !== "/") throw new Error("decision provenance packet must be bound to the canonical root route");
  if (packet.build?.authority !== "NEXUS_MCP_BUILD_MANIFEST_V1" || packet.build?.target !== `apps/${projectId}` || !SHA256.test(packet.build?.outputDigest ?? "") || !SHA256.test(packet.build?.manifestSha256 ?? "")) {
    throw new Error("decision provenance packet has invalid exact-SHA build evidence");
  }
  if (!packet.trace || packet.trace.authority !== "NEXUS_DECISION_TRACE_V1" || !SHA256.test(packet.trace.traceHash ?? "") || !Array.isArray(packet.trace.entries) || packet.trace.entries.length === 0) {
    throw new Error("decision provenance packet has invalid trace evidence");
  }
  if (packet.coverage?.status !== "PASS" || !Array.isArray(packet.coverage.missingElementIds) || packet.coverage.missingElementIds.length !== 0 || !Array.isArray(packet.coverage.unknownElementIds) || packet.coverage.unknownElementIds.length !== 0) {
    throw new Error("decision provenance packet coverage is not PASS");
  }

  const renderedElementIds = canonicalStrings(packet.renderedElementIds, "rendered decision element ids");
  const requiredElementIds = canonicalStrings(packet.coverage.requiredElementIds, "decision coverage required element ids");
  if (JSON.stringify(renderedElementIds) !== JSON.stringify(requiredElementIds)) throw new Error("decision coverage is not bound to the rendered element inventory");
  const traceElementIds = [...new Set(packet.trace.entries.map((entry) => entry?.elementId))].sort((a, b) => String(a).localeCompare(String(b), "en"));
  if (traceElementIds.some((value) => typeof value !== "string") || JSON.stringify(traceElementIds) !== JSON.stringify(renderedElementIds)) {
    throw new Error("decision trace entries do not exactly cover the rendered element inventory");
  }

  const browserRoot = join(repositoryRoot, "artifacts", "browser-capture", projectId);
  const browserPath = join(browserRoot, "evidence-manifest.json");
  const browserReal = await confinedRegularFile(browserRoot, browserPath, "browser evidence manifest");
  const browserBytes = await readFile(browserReal);
  const browser = JSON.parse(browserBytes.toString("utf8"));
  if (browser.schemaVersion !== 1 || browser.authority !== "NEXUS_CLIENT_BROWSER_EVIDENCE_V1" || browser.projectId !== projectId || browser.sourceRevision !== sourceRevision) {
    throw new Error("decision provenance cannot bind to stale or cross-project browser evidence");
  }
  if (browser.build?.authority !== packet.build.authority || browser.build?.target !== packet.build.target || browser.build?.outputDigest !== packet.build.outputDigest || browser.build?.manifestSha256 !== packet.build.manifestSha256) {
    throw new Error("decision provenance and browser evidence are bound to different exact-SHA builds");
  }

  return Object.freeze({
    trace: packet.trace,
    check: Object.freeze({
      id: "decision-trace",
      status: "PASS",
      detail: `verified rendered-DOM Decision Trace for ${projectId} on exact build ${packet.build.outputDigest}`,
      evidenceIds: Object.freeze([
        `file:${normalizePath(relative(repositoryRoot, decisionReal))}:sha256:${sha256(decisionBytes)}`,
        `file:${normalizePath(relative(repositoryRoot, browserReal))}:sha256:${sha256(browserBytes)}`,
      ]),
    }),
  });
}
