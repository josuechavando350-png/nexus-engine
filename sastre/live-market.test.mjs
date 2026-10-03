import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { captureLivePage, discoverSitePages, runLiveMarket } from './live-market.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const scope = { tenantId: 'tenant-a', organizationId: 'org-a', brandId: 'brand-a' };
const date = '2026-09-19T12:00:00.000Z';
const request = { scope, target: { id: 'client', url: 'https://client.example/' }, competitors: [{ id: 'rival', url: 'https://rival.example/' }] };
function fixtureCapture(terms, authority = 'CONTROLLED_TEST') {
  return async (url, observedAt, options) => ({ scope: options.scope, url, observedAt, authority,
    bodyDigest: sha(url), observationDigest: sha(url + observedAt), visibleTerms: terms[url] ?? [], title: 'Observed', description: null });
}
const discovery = async site => ({ urls: [site.url, `${site.url}services`], limitation: null });

test('fresh multi-page comparison includes only captured evidence and does not claim clients', async () => {
  const capture = fixtureCapture({ 'https://client.example/': ['defensa'], 'https://client.example/services': ['amparo'], 'https://rival.example/': ['defensa', 'urgente'], 'https://rival.example/services': ['amparo', 'urgente'] });
  const report = await runLiveMarket(request, { capture, discover: discovery, clock: () => date });
  assert.equal(report.status, 'OBSERVED');
  assert.equal(report.evidenceAuthority, 'CONTROLLED_TEST');
  assert.deepEqual(report.lexicalGaps, [{ term: 'urgente', competitorCount: 1, competitorIds: ['rival'] }]);
  assert.equal(report.sites[0].pages.length, 2);
  assert.equal(report.reportDigest.length, 64);
  assert.match(report.nonClaim, /NOT_SEARCH_VOLUME/);
});

test('without competitors, cold start reports insufficient coverage, not zero demand', async () => {
  const report = await runLiveMarket({ ...request, competitors: [] }, { capture: fixtureCapture({}), discover: discovery, clock: () => date });
  assert.equal(report.status, 'INSUFFICIENT_MARKET_COVERAGE');
  assert.deepEqual(report.lexicalGaps, []);
});

test('rejects cross-tenant evidence, mixed authorities and off-origin discovery', async () => {
  const wrong = async (url, observedAt, options) => ({ ...await fixtureCapture({})(url, observedAt, options), scope: { ...scope, tenantId: 'other' } });
  await assert.rejects(runLiveMarket(request, { capture: wrong, discover: discovery, clock: () => date }), /wrong-scope/);
  const mixed = async (url, observedAt, options) => fixtureCapture({}, url.includes('rival') ? 'PUBLIC_HTTP_CAPTURE' : 'CONTROLLED_TEST')(url, observedAt, options);
  await assert.rejects(runLiveMarket(request, { capture: mixed, discover: discovery, clock: () => date }), /injected capture cannot claim live/);
  await assert.rejects(runLiveMarket(request, { capture: fixtureCapture({}), discover: async site => ({ urls: [site.url, 'https://evil.example/'] }), clock: () => date }), /escaped site origin/);
});

test('partial page failure is disclosed and homepage failure stops the report', async () => {
  const capture = async (url, observedAt, options) => {
    if (url.endsWith('services')) throw new Error('503 upstream');
    return fixtureCapture({})(url, observedAt, options);
  };
  const report = await runLiveMarket(request, { capture, discover: discovery, clock: () => date });
  assert.equal(report.status, 'PARTIAL');
  assert.match(report.sites[0].failures[0].reason, /503/);
  await assert.rejects(runLiveMarket(request, { capture: async () => { throw new Error('offline'); }, discover: discovery, clock: () => date }), /offline/);
});

test('robots and sitemap discovery stays same-origin and fails closed', async () => {
  const bodies = new Map([
    ['https://site.example/robots.txt', 'User-agent: *\nDisallow: /private\n'],
    ['https://site.example/sitemap.xml', '<urlset><url><loc>https://site.example/public</loc></url><url><loc>https://site.example/private/data</loc></url><url><loc>https://other.example/out</loc></url></urlset>'],
  ]);
  const fetchPublic = async url => new Response(bodies.get(url), { status: bodies.has(url) ? 200 : 404 });
  const result = await discoverSitePages({ url: 'https://site.example/' }, { fetchPublic });
  assert.deepEqual(result.urls, ['https://site.example/', 'https://site.example/public']);
  await assert.rejects(discoverSitePages({ url: 'https://site.example/' }, { fetchPublic: async url => url.endsWith('robots.txt') ? new Response('User-agent: *\nCrawl-delay: 10') : fetchPublic(url) }), /robots disallows homepage/);
});

test('live HTML adapter emits different digests when the observed page changes', async () => {
  const html = value => new Response(`<html><head><title>Title ${value}</title></head><body>Defensa ${value}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  const a = await captureLivePage('https://site.example/', date, { scope, fetchPublic: async () => html('uno') });
  const b = await captureLivePage('https://site.example/', date, { scope, fetchPublic: async () => html('dos') });
  assert.notEqual(a.bodyDigest, b.bodyDigest);
  assert.notEqual(a.observationDigest, b.observationDigest);
  assert.equal(a.authority, 'CONTROLLED_TEST');
});

test('discovery blocks a site with disallowed home or unavailable robots', async () => {
  const fetchPublic = async () => new Response('User-agent: *\nDisallow: /', { status: 200 });
  await assert.rejects(discoverSitePages({ url: 'https://site.example/' }, { fetchPublic }), /robots disallows homepage/);
  await assert.rejects(discoverSitePages({ url: 'https://site.example/' }, { fetchPublic: async () => { throw new Error('offline'); } }), /robots unavailable/);
});

test('stalled robots response is bounded by abort even after HTTP headers arrive', async () => {
  const controller = new AbortController();
  const fetchPublic = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  const pending = discoverSitePages({ url: 'https://site.example/' }, { fetchPublic, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled read')), 20);
  await assert.rejects(pending, /robots unavailable: cancelled read/);
});

test('robots policy rejects same-origin redirects into disallowed paths before requesting them', async () => {
  const requested = [];
  const fetchPublic = async url => {
    requested.push(url);
    return new Response(null, { status: 302, headers: { location: '/private/case' } });
  };
  await assert.rejects(captureLivePage('https://site.example/', date, {
    scope, fetchPublic, allowedPath: path => !path.startsWith('/private'),
  }), /robots disallows redirect destination/);
  assert.deepEqual(requested, ['https://site.example/']);
});
