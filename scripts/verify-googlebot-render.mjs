import {
  diffGooglebotRenderEvidence,
  googlebotEvidenceDigest,
  validateGooglebotRenderDiffResult,
} from "../packages/capture/dist/capture/googlebot-render-diff.js";
import {
  observeHttpFetchAsGooglebot,
  simulateGooglebotRender,
} from "../packages/capture/dist/capture/googlebot-runtime.js";
import { inspectUrlWithSearchConsole } from "../packages/capture/dist/capture/url-inspection-adapter.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;

function usage() {
  return "usage: node scripts/verify-googlebot-render.mjs --url <https-url> --tenant <tenantId> --brand <brandId> [--site-url <search-console-property>] [--language <BCP47>] [--allow-origin <origin>] [--timeout-ms <100..60000>] [--require-google-api-observed]";
}

function parseInteger(value, field, min, max) {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${field} must be from ${min} to ${max}`);
  return parsed;
}

function parseArgs(argv) {
  const result = {
    url: null,
    tenant: null,
    brand: null,
    siteUrl: null,
    language: undefined,
    allowOrigins: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    requireGoogleApiObserved: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-google-api-observed") {
      result.requireGoogleApiObserved = true;
      continue;
    }
    if (["--url", "--tenant", "--brand", "--site-url", "--language", "--allow-origin", "--timeout-ms"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--url") result.url = value;
      else if (arg === "--tenant") result.tenant = value;
      else if (arg === "--brand") result.brand = value;
      else if (arg === "--site-url") result.siteUrl = value;
      else if (arg === "--language") result.language = value;
      else if (arg === "--allow-origin") result.allowOrigins.push(value);
      else result.timeoutMs = parseInteger(value, "timeoutMs", 100, MAX_TIMEOUT_MS);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!result.url || !result.tenant || !result.brand) throw new Error(usage());
  if (result.requireGoogleApiObserved && !result.siteUrl) throw new Error("--require-google-api-observed requires --site-url");
  if (result.allowOrigins.length > 16) throw new Error("--allow-origin may be supplied at most 16 times");
  return result;
}

function safeIdentity(value, field, max) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${field} contains control characters`);
  }
  return trimmed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = Object.freeze({
    tenantId: safeIdentity(args.tenant, "tenant", 128),
    brandId: safeIdentity(args.brand, "brand", 128),
  });
  const overallController = new AbortController();
  const overallTimeout = setTimeout(() => overallController.abort(), Math.min(MAX_TIMEOUT_MS * 2, args.timeoutMs * 3));
  try {
    const fetchPromise = observeHttpFetchAsGooglebot(args.url, {
      signal: overallController.signal,
      timeoutMs: args.timeoutMs,
      allowedOrigins: args.allowOrigins,
    });
    const renderPromise = simulateGooglebotRender(args.url, {
      signal: overallController.signal,
      timeoutMs: args.timeoutMs,
    });
    const inspectionPromise = args.siteUrl === null
      ? Promise.resolve(null)
      : inspectUrlWithSearchConsole({
        inspectionUrl: args.url,
        siteUrl: args.siteUrl,
        languageCode: args.language,
      }, {
        accessToken: process.env.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN ?? null,
        signal: overallController.signal,
        timeoutMs: args.timeoutMs,
      });

    const [observedFetch, simulatedRender, urlInspection] = await Promise.all([fetchPromise, renderPromise, inspectionPromise]);
    const renderDiff = diffGooglebotRenderEvidence({
      scope,
      expectedUrl: args.url,
      baseline: observedFetch,
      candidate: simulatedRender,
    });
    validateGooglebotRenderDiffResult(renderDiff);

    const output = Object.freeze({
      capability: "#16_GOOGLEBOT_RENDER_DIFF_URL_INSPECTION",
      scope,
      targetUrl: renderDiff.expectedUrl,
      observedFetch,
      simulatedRender,
      renderDiff,
      urlInspection,
      inspectionBindingDigest: urlInspection === null ? null : googlebotEvidenceDigest({ scope, targetUrl: renderDiff.expectedUrl, urlInspection }),
      interpretation: Object.freeze({
        observedFetch: "NEXUS-origin HTTP fetch using a Googlebot user-agent; it is not evidence of a Google-origin crawl",
        simulatedRender: "Playwright-based Googlebot-like render simulation; it is not a Google-operated render",
        urlInspection: "Search Console API evidence, when present, describes Google's indexed-version inspection status and does not verify the simulated render",
      }),
    });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

    if (observedFetch.status !== "OBSERVED_FETCH" || simulatedRender.status !== "SIMULATED_RENDER") process.exitCode = 2;
    if (args.requireGoogleApiObserved && urlInspection?.status !== "GOOGLE_API_OBSERVED") process.exitCode = 2;
  } finally {
    clearTimeout(overallTimeout);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
