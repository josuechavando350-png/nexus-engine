import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { publishVersionedEvidenceSnapshot } from "../evidence/versioned-evidence-writer.mjs";
import { runTenantSidecarJob } from "../sidecar/tenant-worker.mjs";

export const NEXUSBOT_CANARY_SITE_ID = "nexus-bot-studio";
export const NEXUSBOT_CANARY_ORIGIN = "https://nexusbotstudio.com";
const ALLOWED_HOSTS = new Set(["nexusbotstudio.com", "www.nexusbotstudio.com"]);
const DEFAULT_MAX_ROUTES = 24;
const MAX_SITEMAP_BYTES = 512_000;
const MAX_PAGE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function decision(status, reason, generation = 0, extra = {}) {
  return Object.freeze({
    siteId: NEXUSBOT_CANARY_SITE_ID,
    status,
    reason,
    controlGeneration: generation,
    ...extra,
  });
}

function controlMatches(control, generation) {
  return control?.authorized === true && control?.integrityOk === true && control?.generation === generation;
}

function allowedHttpsUrl(raw, expectedPath = null) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) return null;
  if (url.username || url.password || url.hash) return null;
  if (expectedPath !== null && url.pathname !== expectedPath) return null;
  return url;
}

function routeFromUrl(raw) {
  const url = allowedHttpsUrl(raw);
  if (!url || url.search) return null;
  const path = url.pathname || "/";
  if (!path.startsWith("/") || path.includes("\0") || path.length > 240) return null;
  return path;
}

function decodeXmlText(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

export function extractSameTenantRoutes(xml, maxRoutes = DEFAULT_MAX_ROUTES) {
  if (typeof xml !== "string") throw new TypeError("sitemap XML must be a string");
  if (!Number.isSafeInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 64) throw new TypeError("maxRoutes must be 1..64");
  const routes = new Set(["/"]);
  const pattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;
  for (const match of xml.matchAll(pattern)) {
    const route = routeFromUrl(decodeXmlText(match[1].trim()));
    if (route) routes.add(route);
    if (routes.size >= maxRoutes) break;
  }
  return [...routes].sort().slice(0, maxRoutes);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, digits) => {
      const code = Number(digits);
      return Number.isSafeInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isSafeInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

export function visibleTextFromHtml(html) {
  if (typeof html !== "string") throw new TypeError("HTML must be a string");
  const withoutNonVisible = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withoutNonVisible).normalize("NFC").replace(/\s+/g, " ").trim();
}

async function fetchBounded(fetchImpl, url, { timeoutMs, maxBytes, contentType }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: contentType },
    });
    const finalUrl = allowedHttpsUrl(response.url || url);
    if (!finalUrl) throw new Error("cross-tenant redirect rejected");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader !== null) {
      const declared = Number(declaredHeader);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
        throw new Error("response exceeds byte limit");
      }
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("response exceeds byte limit");
    return { response, finalUrl, bytes };
  } finally {
    clearTimeout(timer);
  }
}

async function discoverRoutes(fetchImpl, timeoutMs, maxRoutes) {
  try {
    const { bytes } = await fetchBounded(fetchImpl, `${NEXUSBOT_CANARY_ORIGIN}/sitemap.xml`, {
      timeoutMs,
      maxBytes: MAX_SITEMAP_BYTES,
      contentType: "application/xml,text/xml;q=0.9,*/*;q=0.1",
    });
    return extractSameTenantRoutes(bytes.toString("utf8"), maxRoutes);
  } catch {
    return ["/"];
  }
}

async function collectDocuments({ controlRoot, fetchImpl, generation, timeoutMs, maxRoutes }) {
  const routes = await discoverRoutes(fetchImpl, timeoutMs, maxRoutes);
  const documentsById = new Map();
  const failures = [];
  for (const route of routes) {
    const control = await readTenantControl({ controlRoot, siteId: NEXUSBOT_CANARY_SITE_ID });
    if (!controlMatches(control, generation)) {
      return { aborted: control, integrityFailure: null, routes, documents: [], failures };
    }
    try {
      const { response, finalUrl, bytes } = await fetchBounded(fetchImpl, `${NEXUSBOT_CANARY_ORIGIN}${route}`, {
        timeoutMs,
        maxBytes: MAX_PAGE_BYTES,
        contentType: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      });
      const type = String(response.headers.get("content-type") || "").toLowerCase();
      if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
        failures.push({ route, reason: "NON_HTML_RESPONSE" });
        continue;
      }
      const text = visibleTextFromHtml(bytes.toString("utf8"));
      if (!text) {
        failures.push({ route, reason: "VISIBLE_TEXT_EMPTY" });
        continue;
      }
      const documentId = routeFromUrl(finalUrl.href);
      if (!documentId) {
        failures.push({ route, reason: "FINAL_ROUTE_INVALID" });
        continue;
      }
      const prior = documentsById.get(documentId);
      if (prior !== undefined && prior !== text) {
        return { aborted: null, integrityFailure: "CONFLICTING_FINAL_DOCUMENT", routes, documents: [], failures };
      }
      documentsById.set(documentId, text);
    } catch (error) {
      failures.push({ route, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const documents = [...documentsById.entries()]
    .map(([document_id, text]) => ({ document_id, text }))
    .sort((left, right) => left.document_id.localeCompare(right.document_id));
  return { aborted: null, integrityFailure: null, routes, documents, failures };
}

export async function runNexusBotStudioCanary({
  controlRoot,
  evidenceRoot,
  config = {},
  fetchImpl = globalThis.fetch,
  executeSuite,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRoutes = DEFAULT_MAX_ROUTES,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("timeoutMs must be 1..30000");
  if (!Number.isSafeInteger(maxRoutes) || maxRoutes < 1 || maxRoutes > 64) throw new TypeError("maxRoutes must be 1..64");

  const initial = await readTenantControl({ controlRoot, siteId: NEXUSBOT_CANARY_SITE_ID });
  if (!initial.authorized) {
    return decision("OFF", initial.reason, initial.generation, { discoveredRoutes: 0, collectedDocuments: 0 });
  }
  const generation = initial.generation;

  const collection = await collectDocuments({ controlRoot, fetchImpl, generation, timeoutMs, maxRoutes });
  if (collection.aborted) {
    const current = collection.aborted;
    return decision("OFF", current.authorized ? "STALE_CONTROL_GENERATION" : current.reason, current.generation, {
      discoveredRoutes: collection.routes.length,
      collectedDocuments: 0,
    });
  }
  if (collection.integrityFailure) {
    return decision("BLOCKED", collection.integrityFailure, generation, {
      discoveredRoutes: collection.routes.length,
      collectedDocuments: 0,
      failedRoutes: collection.failures.length,
    });
  }
  if (collection.documents.length === 0) {
    return decision("INSUFFICIENT_DATA", "CANARY_CONTENT_EVIDENCE_EMPTY", generation, {
      discoveredRoutes: collection.routes.length,
      collectedDocuments: 0,
      failedRoutes: collection.failures.length,
    });
  }

  const beforePublish = await readTenantControl({ controlRoot, siteId: NEXUSBOT_CANARY_SITE_ID });
  if (!controlMatches(beforePublish, generation)) {
    return decision("OFF", beforePublish.authorized ? "STALE_CONTROL_GENERATION" : beforePublish.reason, beforePublish.generation, {
      discoveredRoutes: collection.routes.length,
      collectedDocuments: 0,
    });
  }

  let publication;
  try {
    publication = await publishVersionedEvidenceSnapshot({
      evidenceRoot,
      siteId: NEXUSBOT_CANARY_SITE_ID,
      controlGeneration: generation,
      datasets: { content_documents: collection.documents },
    });
  } catch {
    return decision("BLOCKED", "EVIDENCE_PUBLICATION_FAILED", generation, {
      discoveredRoutes: collection.routes.length,
      collectedDocuments: collection.documents.length,
      failedRoutes: collection.failures.length,
    });
  }

  const afterPublish = await readTenantControl({ controlRoot, siteId: NEXUSBOT_CANARY_SITE_ID });
  if (!controlMatches(afterPublish, generation)) {
    return decision("OFF", afterPublish.authorized ? "STALE_CONTROL_GENERATION" : afterPublish.reason, afterPublish.generation, {
      discoveredRoutes: collection.routes.length,
      collectedDocuments: 0,
      publishedSnapshotSuppressed: true,
    });
  }

  const workerArgs = {
    controlRoot,
    evidenceRoot,
    siteId: NEXUSBOT_CANARY_SITE_ID,
    config,
  };
  if (executeSuite !== undefined) workerArgs.executeSuite = executeSuite;
  const result = await runTenantSidecarJob(workerArgs);
  return Object.freeze({
    ...result,
    canary: Object.freeze({
      origin: NEXUSBOT_CANARY_ORIGIN,
      discoveredRoutes: collection.routes.length,
      collectedDocuments: collection.documents.length,
      failedRoutes: collection.failures.length,
      snapshotId: publication.snapshotId,
      manifestHash: publication.manifestHash,
    }),
  });
}
