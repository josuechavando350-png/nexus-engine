#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readTenantEvidenceSnapshot } from "../../../seo-avengers-2500/evidence/tenant-evidence.mjs";

const TARGETS_URL = new URL("../competitive-targets.json", import.meta.url);
const targets = JSON.parse(await readFile(TARGETS_URL, "utf8"));

function normalizeQuery(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

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
    const observedQueries = new Set((snapshot.datasets.keyword_coverage_records ?? []).map((row) => normalizeQuery(row?.query)));
    const uncoveredTargets = targets.targets.filter((target) => !observedQueries.has(normalizeQuery(target.query)));
    const pass = missing.length === 0 && provenance.length === 1 && uncoveredTargets.length === 0;
    process.stdout.write(JSON.stringify({
      siteId,
      status: pass ? "PASS" : "UNKNOWN",
      reason: pass ? "COMPETITIVE_EVIDENCE_READY" : "COMPETITIVE_EVIDENCE_INCOMPLETE",
      missing,
      competitiveProvenanceCount: provenance.length,
      targetCount: targets.targets.length,
      uncoveredTargets: uncoveredTargets.map(({ cluster, query, route }) => ({ cluster, query, route })),
      controlGeneration: snapshot.controlGeneration,
      manifestHash: snapshot.manifestHash,
    }) + "\n");
    process.exitCode = pass ? 0 : 2;
  }
}
