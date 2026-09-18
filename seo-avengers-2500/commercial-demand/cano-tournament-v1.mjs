import { createHash } from 'node:crypto';
import { validateCanoEvidence } from './cano-evidence-v1.mjs';

const sha = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const sum = (rows) => rows.reduce((total, row) => total + BigInt(row.value), 0n);
const asSafeCount = (value) => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
const key = (row) => `${row.metric}|${row.window.start}|${row.window.end}|${row.source.provider}|${row.source.accountOrProperty}`;

/** An executable CANO-only tournament of evidence completeness, NOT a forecast or a V4 winner. */
export function runCanoTournamentV1(input) {
  const manifest = validateCanoEvidence(input);
  const observed = manifest.evidence.filter((row) => row.evidenceClass === 'OBSERVED' || row.evidenceClass === 'CLIENT_CONFIRMED');
  const unavailable = manifest.evidence.filter((row) => row.evidenceClass === 'UNAVAILABLE');
  const keys = new Set();
  for (const row of manifest.evidence) {
    const identity = key(row);
    if (keys.has(identity)) throw new Error(`CANO_TOURNAMENT_INVALID: duplicate metric/window/source ${identity}`);
    keys.add(identity);
  }
  const metrics = [...new Set(manifest.evidence.map((row) => row.metric))].sort().map((metric) => {
    const rows = observed.filter((row) => row.metric === metric);
    const missing = unavailable.filter((row) => row.metric === metric);
    // Never sum overlapping windows, even from distinct accounts: that would double-count.
    const sorted = [...rows].sort((a, b) => a.window.start.localeCompare(b.window.start));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].window.start <= sorted[i - 1].window.end) {
        throw new Error(`CANO_TOURNAMENT_INVALID: overlapping ${metric} windows; no safe aggregate`);
      }
    }
    return {
      metric,
      status: missing.length ? 'INCOMPLETE' : 'AVAILABLE',
      observedCount: rows.length ? asSafeCount(sum(rows)) : null,
      observedWindows: rows.map((row) => ({ ...row.window, evidenceId: row.id })),
      unavailableWindows: missing.map((row) => ({ ...row.window, evidenceId: row.id, reason: row.reason })),
    };
  });
  const has = (metric) => metrics.some((row) => row.metric === metric && row.observedCount !== null && row.status === 'AVAILABLE');
  const missingRequirements = ['ads_clicks', 'ads_primary_conversions', 'gsc_clicks', 'gsc_impressions', 'whatsapp_conversations', 'qualified_inquiries', 'retained_clients'].filter((metric) => !has(metric));
  const unsigned = {
    schemaVersion: 1,
    engineId: 'CANO_EVIDENCE_BOUND_TOURNAMENT_V1',
    siteId: manifest.siteId,
    domain: manifest.domain,
    manifestSha256: manifest.manifestSha256,
    status: missingRequirements.length ? 'BLOCKED_INCOMPLETE_EVIDENCE' : 'EVIDENCE_COUNTS_READY_FOR_REVIEW',
    missingRequirements,
    metrics,
    gaussStatus: 'NOT_EXECUTED',
    axiomaStatus: 'NOT_EXECUTED',
    businessOutcomeCertification: 'NOT_CERTIFIED',
    interpretation: 'OBSERVED_COUNTS_ONLY_NOT_A_V4_STRATEGY_WINNER_OR_TRAFFIC_LEAD_CLIENT_FORECAST',
  };
  return { ...unsigned, reportSha256: sha(unsigned) };
}
