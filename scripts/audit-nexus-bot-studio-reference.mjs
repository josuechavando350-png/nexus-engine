import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const referencePath = arg("--reference", "references/nexus-bot-studio/reference.json");
const reference = JSON.parse(await readFile(resolve(referencePath), "utf8"));
const canonicalOrigin = arg("--url", reference.canonicalOrigin).replace(/\/$/, "");
const outputPath = arg(
  "--output",
  "artifacts/nexus-bot-studio-reference/runtime-audit.json"
);

const checks = [];
function check(engine, id, pass, detail, evidence = {}) {
  checks.push({ engine, id, status: pass ? "PASS" : "FAIL", detail, evidence });
}

async function get(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      redirect: options.redirect ?? "follow",
      headers: {
        "user-agent":
          options.userAgent ??
          "NEXUS-Reference-Certifier/1.0 (+https://github.com/josuechavando350-png/nexus-engine)",
        accept: options.accept ?? "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(
    `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
    "i"
  ).exec(html)?.[1];
  if (a !== undefined) return a;
  return new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["'][^>]*>`,
    "i"
  ).exec(html)?.[1];
}

function canonicalHref(html) {
  return (
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i.exec(html)?.[1] ??
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[1]
  );
}

function titleOf(html) {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
}

function jsonLdDocuments(html) {
  const docs = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      docs.push(JSON.parse(match[1]));
    } catch {
      // Invalid JSON-LD is reported by the downstream check instead of crashing the audit.
    }
  }
  return docs;
}

function jsonContains(value, needle) {
  return JSON.stringify(value).toLowerCase().includes(needle.toLowerCase());
}

let home;
let homeHtml = "";
let googlebot;
let googlebotHtml = "";
let robots;
let robotsText = "";
let sitemap;
let sitemapText = "";
let www;
let chat;
let vitals;

try {
  home = await get(`${canonicalOrigin}/`);
  homeHtml = await home.text();
} catch (error) {
  check("experience", "home-reachable", false, "Canonical home fetch failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

if (home) {
  check("experience", "home-reachable", home.ok, "Canonical homepage returns a successful response.", {
    status: home.status,
    url: home.url,
  });

  const lower = homeHtml.toLowerCase();
  check(
    "experience",
    "commercial-surface",
    reference.publicOffers.every((offer) =>
      offer.requiredText.some((term) => lower.includes(term.toLowerCase()))
    ),
    "Homepage exposes the two approved commercial surfaces: Webs Premium and AI agents/chatbot."
  );
}

try {
  googlebot = await get(`${canonicalOrigin}/`, {
    userAgent:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  });
  googlebotHtml = await googlebot.text();
} catch (error) {
  check("growth", "googlebot-fetch", false, "Googlebot-equivalent fetch failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

if (home && googlebot) {
  check("growth", "googlebot-fetch", googlebot.ok, "Googlebot-equivalent request can fetch the homepage.", {
    status: googlebot.status,
  });
  check(
    "growth",
    "googlebot-parity",
    titleOf(homeHtml) === titleOf(googlebotHtml) &&
      canonicalHref(homeHtml) === canonicalHref(googlebotHtml),
    "Human and Googlebot responses expose the same title and canonical identity.",
    {
      humanTitle: titleOf(homeHtml),
      botTitle: titleOf(googlebotHtml),
      humanCanonical: canonicalHref(homeHtml),
      botCanonical: canonicalHref(googlebotHtml),
    }
  );
}

if (home) {
  const canonical = canonicalHref(homeHtml);
  const robotsMeta = (metaContent(homeHtml, "robots") ?? "").toLowerCase();
  const jsonLd = jsonLdDocuments(homeHtml);
  check(
    "growth",
    "canonical",
    canonical === `${canonicalOrigin}` || canonical === `${canonicalOrigin}/`,
    "Homepage declares the configured apex as canonical.",
    { canonical }
  );
  check(
    "growth",
    "snippet-eligibility",
    !robotsMeta.includes("noindex") && !robotsMeta.includes("nosnippet"),
    "Publisher controls do not block indexing or snippets.",
    { robotsMeta: robotsMeta || null }
  );
  check(
    "growth",
    "structured-entity",
    jsonLd.length > 0 &&
      jsonContains(jsonLd, "Nexus Bot Studio") &&
      jsonContains(jsonLd, "Webs Premium") &&
      jsonContains(jsonLd, "Agentes de IA"),
    "Factual JSON-LD binds Nexus Bot Studio to the two approved public offers.",
    { jsonLdDocuments: jsonLd.length }
  );
}

try {
  robots = await get(`${canonicalOrigin}/robots.txt`, { accept: "text/plain,*/*" });
  robotsText = await robots.text();
  sitemap = await get(`${canonicalOrigin}/sitemap.xml`, { accept: "application/xml,text/xml,*/*" });
  sitemapText = await sitemap.text();
  check(
    "growth",
    "crawl-surface",
    robots.ok && /user-agent:\s*\*/i.test(robotsText) && /allow:\s*\//i.test(robotsText) && sitemap.ok && sitemapText.includes(canonicalOrigin),
    "robots.txt and sitemap.xml expose the canonical site to crawlers.",
    { robotsStatus: robots.status, sitemapStatus: sitemap.status }
  );
} catch (error) {
  check("growth", "crawl-surface", false, "Robots/sitemap fetch failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

try {
  const wwwUrl = canonicalOrigin.replace("https://", "https://www.");
  www = await get(`${wwwUrl}/`, { redirect: "manual" });
  const location = www.headers.get("location");
  check(
    "growth",
    "www-consolidation",
    [301, 308].includes(www.status) && Boolean(location?.startsWith(canonicalOrigin)),
    "www permanently consolidates into the apex canonical entity.",
    { status: www.status, location }
  );
} catch (error) {
  check("growth", "www-consolidation", false, "www canonicalization check failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

try {
  chat = await get(`${canonicalOrigin}/api/chat`, { accept: "application/json,*/*" });
  check(
    "industrial",
    "chat-runtime",
    chat.status !== 404 && chat.status < 500,
    "Chat runtime is deployed. The audit deliberately does not submit a synthetic conversation.",
    { status: chat.status }
  );
} catch (error) {
  check("industrial", "chat-runtime", false, "Chat runtime probe failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

if (home) {
  check(
    "industrial",
    "chat-discoverability",
    /chatbot/i.test(homeHtml),
    "The public homepage identifies the chatbot capability."
  );
}

try {
  vitals = await get(`${canonicalOrigin}${reference.fieldRum.endpoint}`, {
    accept: "application/json,*/*",
  });
  check(
    "intelligence",
    "field-rum-runtime",
    vitals.status !== 404 && vitals.status < 500,
    "First-party field-RUM endpoint is deployed without generating a fake performance sample.",
    { status: vitals.status, authority: reference.fieldRum.authority }
  );
} catch (error) {
  check("intelligence", "field-rum-runtime", false, "Field-RUM runtime probe failed.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

check(
  "intelligence",
  "field-rum-contract",
  reference.fieldRum.authority === "NEXUS_FIELD_RUM_V1" &&
    ["LCP", "INP", "CLS"].every((metric) => reference.fieldRum.metrics.includes(metric)) &&
    reference.fieldRum.candidateRevisionRequired === true,
  "Reference contract uses the Nexus field-RUM authority and binds evidence to a candidate revision."
);
check(
  "intelligence",
  "crux-non-fabrication",
  reference.externalEvidencePolicy.cruxFabrication === "PROHIBITED",
  "Google CrUX/PageSpeed field data cannot be manufactured by Nexus."
);

if (home) {
  const headers = home.headers;
  const csp =
    headers.get("content-security-policy") ??
    headers.get("content-security-policy-report-only");
  const security = {
    csp: Boolean(csp),
    hsts: Boolean(headers.get("strict-transport-security")),
    nosniff: headers.get("x-content-type-options")?.toLowerCase() === "nosniff",
    frameProtection:
      headers.get("x-frame-options")?.toUpperCase() === "DENY" ||
      Boolean(csp?.includes("frame-ancestors 'none'")),
    referrerPolicy: Boolean(headers.get("referrer-policy")),
    permissionsPolicy: Boolean(headers.get("permissions-policy")),
  };
  check(
    "security",
    "browser-security-headers",
    Object.values(security).every(Boolean),
    "Canonical response exposes the required browser security boundary.",
    security
  );
  check(
    "security",
    "transport",
    home.url.startsWith("https://"),
    "Canonical response remains on HTTPS.",
    { finalUrl: home.url }
  );
}

const engines = Object.fromEntries(
  reference.engines.map((engine) => {
    const evidence = checks.filter((item) => item.engine === engine);
    return [
      engine,
      {
        status:
          evidence.length > 0 && evidence.every((item) => item.status === "PASS")
            ? "PASS"
            : "FAIL",
        checks: evidence.length,
      },
    ];
  })
);
const failures = checks.filter((item) => item.status === "FAIL");
const report = {
  schemaVersion: 1,
  authority: "NEXUS_BOT_STUDIO_REFERENCE_CERTIFIER_V1",
  projectId: reference.projectId,
  canonicalOrigin,
  observedAt: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  engines,
  checks,
  failures: failures.length,
  externalEvidence: {
    aiRecommendationGuarantee: "NOT_CLAIMED",
    googleCruxInclusion: "NOT_CONTROLLED_BY_NEXUS",
  },
};

await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 2;
