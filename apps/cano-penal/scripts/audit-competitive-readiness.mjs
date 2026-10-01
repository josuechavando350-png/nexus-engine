#!/usr/bin/env node
import { readTenantEvidenceSnapshot } from "../../../seo-avengers-2500/evidence/tenant-evidence.mjs";

const controlRoot = process.env.NEXUS_SEO_CONTROL_ROOT?.trim();
const evidenceRoot = process.env.NEXUS_SEO_EVIDENCE_ROOT?.trim();
const siteId = "cano-penal";

if (!controlRoot || !evidenceRoot) {
  process.stdout.write(JSON.stringify({
    siteId,
    status: "UNKNOWN",
    reason: "SEO_CONTROL_OR_EVIDENCE_ROOT_UNCONFIGURED",
  }) + "\n");
  process.exitCode = 2;
} else {
  const snapshot = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId });
  if (snapshot.status !== "READY" || !snapshot.integrityOk) {
    process.stdout.write(JSON.stringify({
      siteId,
      status: snapshot.status,
      reason: snapshot.reason,
      controlGeneration: snapshot.controlGeneration,
      manifestHash: snapshot.manifestHash,
    }) + "\n");
    process.exitCode = 2;
  } else {
    const required = [
      "keyword_coverage_records",
      "search_performance_records",
      "search_performance_history_records",
      "upstream_evidence",
    ];
    const missing = required.filter((key) => !Array.isArray(snapshot.datasets[key]) || snapshot.datasets[key].length === 0);
    const provenance = Array.isArray(snapshot.datasets.upstream_evidence)
      ? snapshot.datasets.upstream_evidence.filter((row) => row?.provider === "NEXUS_COMPETITIVE_SNAPSHOT")
      : [];
    const pass = missing.length === 0 && provenance.length === 1;
    process.stdout.write(JSON.stringify({
      siteId,
      status: pass ? "PASS" : "UNKNOWN",
      reason: pass ? "COMPETITIVE_EVIDENCE_READY" : "COMPETITIVE_EVIDENCE_INCOMPLETE",
      missing,
      competitiveProvenanceCount: provenance.length,
      controlGeneration: snapshot.controlGeneration,
      manifestHash: snapshot.manifestHash,
    }) + "\n");
    process.exitCode = pass ? 0 : 2;
  }
}
