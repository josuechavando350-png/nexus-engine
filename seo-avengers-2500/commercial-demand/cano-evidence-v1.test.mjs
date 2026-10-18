import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCanoEvidence } from './cano-evidence-v1.mjs';

const hash = `sha256:${'a'.repeat(64)}`;
const base = () => ({ schemaVersion: 1, siteId: 'cano-penal', domain: 'canopenal.com', evidence: [{ id: 'ads-clicks-2026-09-01', siteId: 'cano-penal', domain: 'canopenal.com', evidenceClass: 'OBSERVED', metric: 'ads_clicks', unit: 'count', value: 6, source: { provider: 'GOOGLE_ADS', accountOrProperty: 'cano-ads-account' }, window: { start: '2026-09-01', end: '2026-09-01' }, extractedAt: '2026-09-18T19:00:00Z', artifactSha256: hash }] });
const invalid = (change) => { const data = base(); change(data, data.evidence[0]); assert.throws(() => validateCanoEvidence(data), /CANO_EVIDENCE_INVALID/); };
test('validates provenance without certifying external data', () => { const result = validateCanoEvidence(base()); assert.match(result.manifestSha256, /^sha256:[a-f0-9]{64}$/); assert.match(result.status, /NOT_SOURCE_AUTHENTICATED/); });
test('missing Search Console 28-day data stays unavailable, not zero', () => { const data = base(); data.evidence[0] = { ...data.evidence[0], id: 'gsc-28d', metric: 'gsc_clicks', source: { provider: 'GOOGLE_SEARCH_CONSOLE', accountOrProperty: 'sc-domain:canopenal.com' }, evidenceClass: 'UNAVAILABLE', value: null, artifactSha256: null, reason: 'REPORT_PROCESSING' }; assert.equal(validateCanoEvidence(data).evidence[0].value, null); data.evidence[0].value = 0; assert.throws(() => validateCanoEvidence(data), /unavailable/); });
test('rejects duplicate evidence IDs', () => invalid((data) => data.evidence.push(structuredClone(data.evidence[0]))));
test('rejects cross-client domains', () => invalid((_data, row) => { row.domain = 'nexusbotstudio.com'; }));
test('rejects wrong Search Console property', () => invalid((_data, row) => { row.metric = 'gsc_clicks'; row.source = { provider: 'GOOGLE_SEARCH_CONSOLE', accountOrProperty: 'sc-domain:nexusbotstudio.com' }; }));
test('rejects client counts disguised as Ads conversions', () => invalid((_data, row) => { row.metric = 'retained_clients'; }));
test('rejects unverified observed values', () => invalid((_data, row) => { row.artifactSha256 = null; }));
test('rejects invalid dates, windows and nonfinite numbers', () => { invalid((_data, row) => { row.window.end = '2026-08-31'; }); invalid((_data, row) => { row.window.start = '2026-02-30'; }); invalid((_data, row) => { row.value = Infinity; }); });
test('rejects assumed funnel rates as observed counts', () => invalid((_data, row) => { row.evidenceClass = 'ASSUMPTION'; }));
