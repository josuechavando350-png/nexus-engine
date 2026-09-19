import { createHash } from 'node:crypto';

const MAX_COMPETITORS = 5;
const MAX_PAGES_PER_SITE = 5;
const MAX_SITEMAP_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const SHA256 = /^[a-f0-9]{64}$/u;

function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function publicUrl(input, label) {
  const url = new URL(text(input, label, 4096));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.hash) throw new Error(`${label} must be an HTTP(S) URL without credentials or fragments`);
  url.hash = '';
  return url;
}

function normalizedSite(input, label) {
  if (!input || typeof input !== 'object') throw new Error(`${label} must be an object`);
  const url = publicUrl(input.url, `${label}.url`);
  if (url.pathname !== '/' || url.search) throw new Error(`${label}.url must be a site origin (ending in /)`);
  return Object.freeze({ id: text(input.id, `${label}.id`, 128), url: url.href });
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function normalizeScope(input) {
  if (!input || typeof input !== 'object') throw new Error('scope is required');
  return Object.freeze({
    tenantId: text(input.tenantId, 'scope.tenantId', 128),
    organizationId: text(input.organizationId, 'scope.organizationId', 128),
    brandId: text(input.brandId, 'scope.brandId', 128),
  });
}

function sameScope(a, b) {
  return a?.tenantId === b.tenantId && a?.organizationId === b.organizationId && a?.brandId === b.brandId;
}

function readXmlLocations(xml, origin) {
  if (!/<urlset(?:\s|>)/iu.test(xml) || /<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('unsupported sitemap XML');
  const urls = new Set();
  for (const block of xml.matchAll(/<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/giu)) {
    const match = /<loc(?:\s[^>]*)?>([^<]+)<\/loc>/iu.exec(block[1]);
    if (!match) continue;
    const raw = match[1].trim().replace(/&amp;/giu, '&');
    try {
      const url = publicUrl(raw, 'sitemap URL');
      if (url.origin !== origin || url.search || !['http:', 'https:'].includes(url.protocol)) continue;
      urls.add(url.href);
    } catch { /* malformed or cross-origin sitemap entries are not crawled */ }
  }
  return [...urls].sort();
}

// Conservative robots subset: unclear/unsupported directives block capture.
function robotsAllows(robots, path) {
  if (/\b(?:crawl-delay|request-rate)\s*:/iu.test(robots)) return false;
  const groups = [];
  let agents = [];
  let rules = [];
  const flush = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = []; rules = [];
  };
  for (const raw of robots.split(/\r?\n/u)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    const match = /^([a-z-]+)\s*:\s*(.*)$/iu.exec(line);
    if (!match) return false;
    const name = match[1].toLowerCase();
    const value = match[2].trim();
    if (name === 'user-agent') {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if (name === 'allow' || name === 'disallow') {
      if (agents.length) rules.push({ name, value });
    } else if (!['sitemap', 'host'].includes(name)) {
      return false;
    }
  }
  flush();
  const specific = groups.filter(group => group.agents.some(agent => agent === 'nexus-competitive-observation' || agent === 'nexus-competitive-observation/1.0'));
  const relevant = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  const allRules = relevant.flatMap(group => group.rules);
  if (allRules.some(rule => /[*$]/u.test(rule.value))) return false;
  const matches = allRules.filter(rule => rule.value && path.startsWith(rule.value));
  matches.sort((a, b) => b.value.length - a.value.length || (a.name === 'allow' ? -1 : 1));
  return matches.length === 0 || matches[0].name === 'allow';
}

async function readBounded(response, signal, maxBytes = MAX_SITEMAP_BYTES) {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} or empty body`);
  }
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error('response exceeds byte limit');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('cancelled');
      let onAbort;
      const aborted = new Promise((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new Error('cancelled'));
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      let part;
      try { part = await Promise.race([reader.read(), aborted]); }
      finally { signal.removeEventListener('abort', onAbort); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('response exceeds byte limit');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function pinnedFetch(url, signal) {
  // Reuse Nexus's DNS/IP pinning and SSRF protections; never use plain fetch here.
  const { requestPinnedPublicUrl } = await import('../packages/entity-intelligence/src/competitive-public-http.ts');
  return requestPinnedPublicUrl(url, signal);
}

async function withDeadline(operation, signal) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', forward, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('market discovery timed out')), FETCH_TIMEOUT_MS);
  try { return await operation(controller.signal); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', forward); }
}

export async function discoverSitePages(site, { fetchPublic = pinnedFetch, signal } = {}) {
  const base = publicUrl(site.url, 'site.url');
  const home = base.href;
  return withDeadline(async activeSignal => {
    let robots;
    try {
      const response = await fetchPublic(new URL('/robots.txt', base).href, activeSignal);
      if (response.status === 404 || response.status === 410) robots = '';
      else robots = await readBounded(response, activeSignal);
    } catch (error) {
      throw new Error(`robots unavailable: ${error instanceof Error ? error.message : 'error'}`);
    }
    if (!robotsAllows(robots, '/')) throw new Error('robots disallows homepage');
    try {
      const xml = await readBounded(await fetchPublic(new URL('/sitemap.xml', base).href, activeSignal), activeSignal);
      const candidates = readXmlLocations(xml, base.origin).filter(url => url !== home && robotsAllows(robots, new URL(url).pathname));
      return { urls: [home, ...candidates.slice(0, MAX_PAGES_PER_SITE - 1)], limitation: candidates.length > MAX_PAGES_PER_SITE - 1 ? 'sitemap page cap reached' : null };
    } catch (error) {
      return { urls: [home], limitation: `sitemap unavailable: ${error instanceof Error ? error.message : 'error'}` };
    }
  }, signal);
}

function htmlText(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:amp|quot|apos|lt|gt);/giu, ' ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
}
function firstHtmlMatch(html, pattern) {
  return pattern.exec(html)?.[1]?.replace(/\s+/gu, ' ').trim().slice(0, 2_000) || null;
}
export async function captureLivePage(url, observedAt, { scope, signal, fetchPublic = pinnedFetch } = {}) {
  const base = publicUrl(url, 'capture URL');
  const inputUrl = base.href;
  return withDeadline(async activeSignal => {
    let current = inputUrl;
    let html;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchPublic(current, activeSignal);
      if (response.status >= 300 && response.status <= 399) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirects === 3) throw new Error('unresolvable redirect');
        const destination = publicUrl(new URL(location, current).href, 'redirect URL');
        if (destination.origin !== base.origin) throw new Error('cross-origin redirect blocked');
        current = destination.href;
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new Error('capture requires HTTP 200 HTML');
      }
      html = await readBounded(response, activeSignal, 2_000_000);
      break;
    }
    if (html === undefined) throw new Error('capture did not receive HTML');
    const counts = new Map();
    for (const term of htmlText(html).split(/[^a-z0-9]+/gu)) {
      if (term.length >= 3 && term.length <= 80) counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    const terms = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2_000).map(([term]) => term);
    const core = {
      scope, url: inputUrl, finalUrl: current, observedAt,
      authority: fetchPublic === pinnedFetch ? 'PUBLIC_HTTP_CAPTURE' : 'CONTROLLED_TEST',
      title: firstHtmlMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/iu),
      description: firstHtmlMatch(html, /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/iu),
      visibleTerms: terms, bodyDigest: sha256(html),
    };
    return { ...core, observationDigest: sha256(JSON.stringify(core)) };
  }, signal);
}

async function defaultCapture(url, observedAt, options) {
  return captureLivePage(url, observedAt, options);
}

function validateObservation(observation, scope, url, observedAt) {
  if (!observation || !sameScope(observation.scope, scope) || observation.url !== url || observation.observedAt !== observedAt || !SHA256.test(observation.bodyDigest) || !SHA256.test(observation.observationDigest)) {
    throw new Error('capture returned invalid or wrong-scope evidence');
  }
  if (!['PUBLIC_HTTP_CAPTURE', 'CONTROLLED_TEST'].includes(observation.authority)) throw new Error('unknown evidence authority');
  if (!Array.isArray(observation.visibleTerms) || observation.visibleTerms.some(term => typeof term !== 'string')) throw new Error('invalid captured terms');
}

export async function runLiveMarket(request, adapters = {}) {
  if (!request || typeof request !== 'object') throw new Error('request is required');
  const scope = normalizeScope(request.scope);
  const target = normalizedSite(request.target, 'target');
  const competitors = (request.competitors ?? []).map((site, i) => normalizedSite(site, `competitors[${i}]`));
  if (competitors.length > MAX_COMPETITORS) throw new Error(`maximum ${MAX_COMPETITORS} competitors per run`);
  const ids = [target.id, ...competitors.map(site => site.id)];
  const origins = [target.url, ...competitors.map(site => site.url)];
  if (new Set(ids).size !== ids.length || new Set(origins).size !== origins.length) throw new Error('duplicate site ID or origin');
  const clock = adapters.clock ?? (() => new Date().toISOString());
  const observedAt = clock();
  if (typeof observedAt !== 'string' || new Date(observedAt).toISOString() !== observedAt) throw new Error('clock must return canonical ISO-8601');
  const capture = adapters.capture ?? defaultCapture;
  const discover = adapters.discover ?? ((site) => discoverSitePages(site, { signal: adapters.signal }));
  const sites = [];
  let authority = null;
  for (const site of [target, ...competitors]) {
    if (adapters.signal?.aborted) throw adapters.signal.reason ?? new Error('cancelled');
    const discovered = await discover(site);
    if (!discovered || !Array.isArray(discovered.urls) || discovered.urls[0] !== site.url || discovered.urls.length > MAX_PAGES_PER_SITE || new Set(discovered.urls).size !== discovered.urls.length) throw new Error('invalid sitemap discovery result');
    const pages = [];
    const failures = [];
    for (const url of discovered.urls) {
      const normalized = publicUrl(url, 'discovered url');
      if (normalized.origin !== new URL(site.url).origin || normalized.href !== url) throw new Error('discovery escaped site origin');
      try {
        const observation = await capture(url, observedAt, { scope, signal: adapters.signal });
        validateObservation(observation, scope, url, observedAt);
        if (adapters.capture && observation.authority !== 'CONTROLLED_TEST') throw new Error('injected capture cannot claim live authority');
        if (authority && observation.authority !== authority) throw new Error('mixed test and live evidence');
        authority = observation.authority;
        pages.push({ url, title: observation.title, description: observation.description, terms: observation.visibleTerms, bodyDigest: observation.bodyDigest, observationDigest: observation.observationDigest });
      } catch (error) {
        if (url === site.url || /mixed test and live evidence|injected capture cannot claim live authority/u.test(String(error))) throw error;
        failures.push({ url, reason: error instanceof Error ? error.message : 'capture failed' });
      }
    }
    sites.push({ id: site.id, url: site.url, pages, failures, discoveryLimitation: discovered.limitation ?? null });
  }
  const targetTerms = new Set(sites[0].pages.flatMap(page => page.terms));
  const gapSources = new Map();
  for (const site of sites.slice(1)) {
    for (const page of site.pages) for (const term of page.terms) {
      if (targetTerms.has(term)) continue;
      const source = gapSources.get(term) ?? new Set();
      source.add(site.id);
      gapSources.set(term, source);
    }
  }
  const lexicalGaps = [...gapSources].map(([term, source]) => ({ term, competitorCount: source.size, competitorIds: [...source].sort() }))
    .sort((a, b) => b.competitorCount - a.competitorCount || a.term.localeCompare(b.term)).slice(0, 500);
  const partial = sites.some(site => site.discoveryLimitation || site.failures.length);
  const core = {
    formatVersion: 'sastre-live-market-v1', scope, observedAt,
    status: competitors.length === 0 ? 'INSUFFICIENT_MARKET_COVERAGE' : partial ? 'PARTIAL' : 'OBSERVED',
    evidenceAuthority: authority === 'PUBLIC_HTTP_CAPTURE' ? 'OBSERVED_PUBLIC_HTTP' : 'CONTROLLED_TEST',
    nonClaim: 'LEXICAL_COVERAGE_NOT_SEARCH_VOLUME_RANKING_TRAFFIC_LEADS_OR_CLIENTS',
    targetId: target.id, sites, lexicalGaps,
  };
  return { ...core, reportDigest: sha256(JSON.stringify(core)) };
}
