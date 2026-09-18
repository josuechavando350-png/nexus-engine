import { createHash } from 'node:crypto';

const CLASSES = new Set(['OBSERVED', 'CLIENT_CONFIRMED', 'ASSUMPTION', 'UNAVAILABLE']);
const METRICS = new Set(['ads_clicks', 'ads_all_conversions', 'ads_primary_conversions', 'gsc_clicks', 'gsc_impressions', 'whatsapp_conversations', 'qualified_inquiries', 'retained_clients']);
const UNITS = new Map([...METRICS].map((metric) => [metric, 'count']));
const ALLOWED = new Map([
  ['ads_clicks', ['GOOGLE_ADS']], ['ads_all_conversions', ['GOOGLE_ADS']], ['ads_primary_conversions', ['GOOGLE_ADS']],
  ['gsc_clicks', ['GOOGLE_SEARCH_CONSOLE']], ['gsc_impressions', ['GOOGLE_SEARCH_CONSOLE']],
  ['whatsapp_conversations', ['CLIENT_RECORD']], ['qualified_inquiries', ['CLIENT_RECORD']], ['retained_clients', ['CLIENT_RECORD']],
]);
function fail(message) { throw new TypeError(`CANO_EVIDENCE_INVALID: ${message}`); }
function record(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`); return value; }
function string(value, name) { if (typeof value !== 'string' || !value.trim()) fail(`${name} must be nonempty`); return value; }
function date(value, name) { string(value, name); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(`${name} must be a valid YYYY-MM-DD date`); return value; }
function timestamp(value, name) { string(value, name); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an offset-aware timestamp`); return value; }
function digest(value, name) { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${name} must be a SHA-256 digest`); return value; }

/** Validates provenance only; never infers a funnel or certifies an external account. */
export function validateCanoEvidence(input) {
  const data = record(input, 'input');
  if (data.schemaVersion !== 1 || data.siteId !== 'cano-penal' || data.domain !== 'canopenal.com') fail('expected CANO schemaVersion 1, siteId and domain');
  if (!Array.isArray(data.evidence) || data.evidence.length === 0) fail('evidence must be a nonempty array');
  const ids = new Set();
  const rows = data.evidence.map((item, index) => {
    const row = record(item, `evidence[${index}]`);
    const id = string(row.id, 'id');
    if (ids.has(id)) fail(`duplicate evidence id ${id}`);
    ids.add(id);
    if (!CLASSES.has(row.evidenceClass)) fail(`${id}: unsupported evidence class`);
    if (!METRICS.has(row.metric)) fail(`${id}: unsupported metric`);
    if (row.unit !== UNITS.get(row.metric)) fail(`${id}: invalid metric unit`);
    if (row.siteId !== data.siteId || row.domain !== data.domain) fail(`${id}: cross-client evidence`);
    const source = record(row.source, `${id}.source`);
    if (!ALLOWED.get(row.metric).includes(source.provider)) fail(`${id}: incompatible metric provider`);
    string(source.accountOrProperty, `${id}.source.accountOrProperty`);
    if (source.provider === 'GOOGLE_SEARCH_CONSOLE' && source.accountOrProperty !== 'sc-domain:canopenal.com') fail(`${id}: wrong Search Console property`);
    if (source.provider === 'CLIENT_RECORD' && source.accountOrProperty !== 'cano-penal') fail(`${id}: wrong client record`);
    date(row.window?.start, `${id}.window.start`);
    date(row.window?.end, `${id}.window.end`);
    if (row.window.start > row.window.end) fail(`${id}: inverted window`);
    timestamp(row.extractedAt, `${id}.extractedAt`);
    if (row.evidenceClass === 'UNAVAILABLE') {
      if (row.value !== null || row.artifactSha256 !== null) fail(`${id}: unavailable must have null value and digest`);
      string(row.reason, `${id}.reason`);
    } else {
      if (typeof row.value !== 'number' || !Number.isSafeInteger(row.value) || row.value < 0) fail(`${id}: value must be a nonnegative safe integer`);
      digest(row.artifactSha256, `${id}.artifactSha256`);
      if (row.evidenceClass === 'ASSUMPTION') fail(`${id}: assumptions require a separate explicit sensitivity schema, not observed counts`);
      if (row.evidenceClass === 'CLIENT_CONFIRMED' && source.provider !== 'CLIENT_RECORD') fail(`${id}: client confirmation requires client record`);
      if (row.evidenceClass === 'OBSERVED' && source.provider === 'CLIENT_RECORD') fail(`${id}: client record must be CLIENT_CONFIRMED`);
    }
    return structuredClone(row);
  });
  const canonical = JSON.stringify({ schemaVersion: 1, siteId: data.siteId, domain: data.domain, evidence: rows });
  return { schemaVersion: 1, siteId: data.siteId, domain: data.domain, evidence: rows, manifestSha256: `sha256:${createHash('sha256').update(canonical).digest('hex')}`, status: 'PROVENANCE_VALIDATED_NOT_SOURCE_AUTHENTICATED_OR_GAUSS_AXIOMA_VERIFIED' };
}
