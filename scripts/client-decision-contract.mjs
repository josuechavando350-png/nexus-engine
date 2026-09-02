import { auditDecisionCoverage, createDecisionTrace } from "../packages/quality/decision-trace.ts";

const ALLOWED_KEYS = new Set(["schemaVersion", "authority", "projectId", "route", "entries"]);
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function evaluateClientDecisionManifest({ projectId, renderedElementIds, manifest }) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new Error("decision manifest projectId must be kebab-case");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("decision manifest must be an object");
  const unknownKeys = Object.keys(manifest).filter((key) => !ALLOWED_KEYS.has(key)).sort((a, b) => a.localeCompare(b, "en"));
  if (unknownKeys.length) throw new Error(`decision manifest contains unsupported fields: ${unknownKeys.join(", ")}`);
  if (manifest.schemaVersion !== 2 || manifest.authority !== "NEXUS_CLIENT_DECISION_MANIFEST_V2") throw new Error("decision manifest must use NEXUS_CLIENT_DECISION_MANIFEST_V2 schemaVersion 2");
  if (manifest.projectId !== projectId) throw new Error(`decision manifest project mismatch: expected ${projectId}`);
  if (manifest.route !== "/") throw new Error("decision manifest route must be /");
  if (!Array.isArray(renderedElementIds) || renderedElementIds.length === 0) throw new Error("rendered decision element inventory must be non-empty");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("decision manifest entries must be non-empty");

  const trace = createDecisionTrace(manifest.entries);
  const coverage = auditDecisionCoverage(renderedElementIds, trace);
  if (coverage.status !== "PASS") {
    const detail = [
      coverage.missingElementIds.length ? `missing=${coverage.missingElementIds.join(",")}` : "",
      coverage.unknownElementIds.length ? `unknown=${coverage.unknownElementIds.join(",")}` : "",
    ].filter(Boolean).join(" ");
    throw new Error(`decision manifest does not cover the rendered client DOM${detail ? `: ${detail}` : ""}`);
  }

  return Object.freeze({ trace, coverage });
}
