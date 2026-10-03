import { RobotsPolicy } from "../06-infiltrador-corporativo/robots.js";
import type {
  SeoAuditActivationReceipt,
  SeoAuditActivationRequest,
  SeoAuditBrowserPort,
  SeoAuditClockPort,
  SeoAuditHttpPort,
  SeoAuditIssue,
  SeoAuditPageReport,
  SeoAuditRunInput,
  SeoAuditRunReport,
  SeoAuditRuntimeConfig,
  SeoAuditTypingSimulationResult,
} from "./contracts.js";
import { buildFatigueTypingPlan } from "./human-telemetry.js";
import { analyzePageSnapshot } from "./metadata.js";
import { inspectSitemaps } from "./sitemap.js";
import { FirstPartySeoAuditUrlPolicy } from "./url-policy.js";

export class SeoProfessionalAuditRuntimeError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "NOT_ACTIVE" | "ACTIVATION_EXPIRED" | "INVALID_INPUT" | "ROBOTS_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "SeoProfessionalAuditRuntimeError";
  }
}

const systemClock: SeoAuditClockPort = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

function validateConfig(config: SeoAuditRuntimeConfig): Readonly<SeoAuditRuntimeConfig> {
  if (!config || typeof config !== "object") throw new SeoProfessionalAuditRuntimeError("INVALID_CONFIG", "SEO audit runtime config is required");
  const policy = new FirstPartySeoAuditUrlPolicy(config.canonicalOrigin);
  if (typeof config.userAgent !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(config.userAgent)) {
    throw new SeoProfessionalAuditRuntimeError("INVALID_CONFIG", "userAgent must be one robots-compatible product token");
  }
  if (!Number.isSafeInteger(config.maxPages) || config.maxPages < 1 || config.maxPages > 500 ||
    !Number.isSafeInteger(config.maxDepth) || config.maxDepth < 0 || config.maxDepth > 10 ||
    !Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1_000 || config.requestTimeoutMs > 30_000 ||
    !Number.isSafeInteger(config.minDelayMs) || !Number.isSafeInteger(config.maxDelayMs) || config.minDelayMs < 0 ||
    config.maxDelayMs > 10_000 || config.minDelayMs > config.maxDelayMs) {
    throw new SeoProfessionalAuditRuntimeError("INVALID_CONFIG", "SEO audit runtime bounds are invalid");
  }
  for (const sitemap of config.sitemapUrls ?? []) policy.authorize(sitemap);
  return Object.freeze({ ...config, canonicalOrigin: policy.origin, sitemapUrls: config.sitemapUrls ? Object.freeze([...config.sitemapUrls]) : undefined });
}

function deterministicDelay(url: string, min: number, max: number): number {
  if (min === max) return min;
  let hash = 2166136261;
  for (const char of url) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const span = max - min + 1;
  return min + ((hash >>> 0) % span);
}

function summary(issues: readonly SeoAuditIssue[], pages: readonly SeoAuditPageReport[]) {
  return Object.freeze({
    crawledPages: pages.length,
    indexablePages: pages.filter((page) => page.indexable).length,
    errorCount: issues.filter((item) => item.severity === "ERROR").length,
    warningCount: issues.filter((item) => item.severity === "WARNING").length,
    infoCount: issues.filter((item) => item.severity === "INFO").length,
  });
}

export class SeoProfessionalAuditRuntime {
  private readonly config: Readonly<SeoAuditRuntimeConfig>;
  private readonly policy: FirstPartySeoAuditUrlPolicy;
  private readonly http: SeoAuditHttpPort;
  private readonly browser: SeoAuditBrowserPort;
  private readonly clock: SeoAuditClockPort;
  private activation: SeoAuditActivationReceipt | null = null;
  private activationSequence = 0;

  constructor(input: {
    readonly config: SeoAuditRuntimeConfig;
    readonly http: SeoAuditHttpPort;
    readonly browser: SeoAuditBrowserPort;
    readonly clock?: SeoAuditClockPort;
  }) {
    this.config = validateConfig(input.config);
    this.policy = new FirstPartySeoAuditUrlPolicy(this.config.canonicalOrigin);
    if (!input.http || typeof input.http.fetch !== "function" || !input.browser || typeof input.browser.inspect !== "function") {
      throw new SeoProfessionalAuditRuntimeError("INVALID_CONFIG", "SEO audit runtime adapters are required");
    }
    this.http = input.http;
    this.browser = input.browser;
    this.clock = input.clock ?? systemClock;
    if (!this.clock || typeof this.clock.now !== "function" || typeof this.clock.sleep !== "function") {
      throw new SeoProfessionalAuditRuntimeError("INVALID_CONFIG", "SEO audit clock adapter is invalid");
    }
  }

  snapshot(): Readonly<{ active: boolean; canonicalOrigin: string; activation: SeoAuditActivationReceipt | null }> {
    const active = this.activation !== null && (this.activation.expiresAtMs === null || this.clock.now() < this.activation.expiresAtMs);
    return Object.freeze({ active, canonicalOrigin: this.policy.origin, activation: active ? this.activation : null });
  }

  activate(request: SeoAuditActivationRequest): SeoAuditActivationReceipt {
    if (!request || typeof request.requestedBy !== "string" || !request.requestedBy.trim() || request.requestedBy.length > 128 ||
      typeof request.reason !== "string" || request.reason.trim().length < 3 || request.reason.length > 500) {
      throw new SeoProfessionalAuditRuntimeError("INVALID_INPUT", "activation requires a bounded requester and reason");
    }
    const now = this.clock.now();
    if (request.expiresAtMs !== undefined && (!Number.isFinite(request.expiresAtMs) || request.expiresAtMs <= now || request.expiresAtMs > now + 24 * 60 * 60 * 1_000)) {
      throw new SeoProfessionalAuditRuntimeError("INVALID_INPUT", "activation expiry must be in the next 24 hours");
    }
    this.activationSequence += 1;
    this.activation = Object.freeze({
      activationId: `seo-audit-${now}-${this.activationSequence}`,
      requestedBy: request.requestedBy.trim(),
      reason: request.reason.trim(),
      activatedAtMs: now,
      expiresAtMs: request.expiresAtMs ?? null,
    });
    return this.activation;
  }

  deactivate(): void {
    this.activation = null;
  }

  private requireActivation(): SeoAuditActivationReceipt {
    if (!this.activation) throw new SeoProfessionalAuditRuntimeError("NOT_ACTIVE", "SEO audit runtime is disabled until explicitly activated");
    if (this.activation.expiresAtMs !== null && this.clock.now() >= this.activation.expiresAtMs) {
      this.activation = null;
      throw new SeoProfessionalAuditRuntimeError("ACTIVATION_EXPIRED", "SEO audit runtime activation expired");
    }
    return this.activation;
  }

  async run(input: SeoAuditRunInput): Promise<SeoAuditRunReport> {
    const activation = this.requireActivation();
    if (!input || !Array.isArray(input.startUrls) || input.startUrls.length === 0 || input.startUrls.length > 100) {
      throw new SeoProfessionalAuditRuntimeError("INVALID_INPUT", "run requires between 1 and 100 first-party start URLs");
    }
    const startedAtMs = this.clock.now();
    const runIssues: SeoAuditIssue[] = [];
    const pages: SeoAuditPageReport[] = [];
    const uxTelemetry: SeoAuditTypingSimulationResult[] = [];
    const seen = new Set<string>();
    const queued = new Set<string>();
    const queue: Array<{ url: string; depth: number; discoveredFrom: string | null }> = [];

    for (const raw of input.startUrls) {
      const url = this.policy.authorize(raw).toString();
      if (!queued.has(url)) {
        queued.add(url);
        queue.push({ url, depth: 0, discoveredFrom: null });
      }
    }

    let robotsText = "";
    try {
      const robotsUrl = new URL("/robots.txt", this.policy.origin).toString();
      const response = await this.http.fetch(robotsUrl, { userAgent: this.config.userAgent, timeoutMs: this.config.requestTimeoutMs });
      if (response.status >= 200 && response.status < 300) robotsText = await response.text();
      else if (response.status !== 404) {
        throw new SeoProfessionalAuditRuntimeError("ROBOTS_UNAVAILABLE", `robots.txt returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof SeoProfessionalAuditRuntimeError) throw error;
      throw new SeoProfessionalAuditRuntimeError("ROBOTS_UNAVAILABLE", `robots.txt could not be evaluated: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    let robots: RobotsPolicy;
    try {
      robots = new RobotsPolicy(robotsText);
    } catch (error) {
      throw new SeoProfessionalAuditRuntimeError("ROBOTS_UNAVAILABLE", `robots.txt is malformed: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const sitemap = await inspectSitemaps({
      http: this.http,
      policy: this.policy,
      userAgent: this.config.userAgent,
      timeoutMs: this.config.requestTimeoutMs,
      robotsText,
      configuredSitemaps: this.config.sitemapUrls,
    });
    runIssues.push(...sitemap.issues);
    for (const url of sitemap.urls) {
      if (!queued.has(url) && queue.length < this.config.maxPages * 4) {
        queued.add(url);
        queue.push({ url, depth: 0, discoveredFrom: "sitemap" });
      }
    }

    while (queue.length > 0 && pages.length < this.config.maxPages) {
      this.requireActivation();
      const current = queue.shift()!;
      if (seen.has(current.url) || current.depth > this.config.maxDepth) continue;
      seen.add(current.url);

      const decision = robots.decide(this.config.userAgent, new URL(current.url));
      if (!decision.allowed) {
        runIssues.push(Object.freeze({
          code: "ROBOTS_DISALLOW",
          severity: "INFO",
          category: "CRAWL",
          url: current.url,
          message: "URL was not crawled because robots.txt disallows this product token.",
          evidence: Object.freeze({ rule: decision.matchedRule ?? "", userAgent: decision.matchedUserAgent }),
        }));
        continue;
      }

      const delay = deterministicDelay(current.url, this.config.minDelayMs, this.config.maxDelayMs);
      if (delay > 0) await this.clock.sleep(delay);

      try {
        const snapshot = await this.browser.inspect({
          url: current.url,
          userAgent: this.config.userAgent,
          timeoutMs: this.config.requestTimeoutMs,
          canonicalOrigin: this.policy.origin,
        });
        const finalUrl = this.policy.authorize(snapshot.finalUrl).toString();
        const analysis = analyzePageSnapshot(snapshot, this.policy);
        const pageReport: SeoAuditPageReport = Object.freeze({
          url: finalUrl,
          status: snapshot.status,
          indexable: analysis.indexable,
          depth: current.depth,
          discoveredFrom: current.discoveredFrom,
          issues: analysis.issues,
          snapshot,
        });
        pages.push(pageReport);
        runIssues.push(...analysis.issues);

        if (current.depth < this.config.maxDepth) {
          for (const link of snapshot.links) {
            if (/\bnofollow\b/iu.test(link.rel)) continue;
            try {
              const discovered = this.policy.resolve(link.href, finalUrl).toString();
              if (!seen.has(discovered) && !queued.has(discovered)) {
                queued.add(discovered);
                queue.push({ url: discovered, depth: current.depth + 1, discoveredFrom: finalUrl });
              }
            } catch {
              // Cross-origin and non-HTTP links are intentionally outside this first-party audit runtime.
            }
          }
        }
      } catch (error) {
        runIssues.push(Object.freeze({
          code: "PAGE_INSPECTION_FAILED",
          severity: "ERROR",
          category: "CRAWL",
          url: current.url,
          message: `Browser inspection failed: ${error instanceof Error ? error.message : "unknown error"}`,
        }));
      }
    }

    for (const scenario of input.uxScenarios ?? []) {
      this.requireActivation();
      const url = this.policy.authorize(scenario.url).toString();
      if (!this.browser.simulateTyping) {
        runIssues.push(Object.freeze({
          code: "UX_TELEMETRY_ADAPTER_UNAVAILABLE",
          severity: "WARNING",
          category: "UX_TELEMETRY",
          url,
          message: "UX fatigue simulation was requested, but the active browser adapter does not implement it.",
        }));
        break;
      }
      if (typeof scenario.selector !== "string" || !scenario.selector.trim() || scenario.selector.length > 256) {
        throw new SeoProfessionalAuditRuntimeError("INVALID_INPUT", "UX telemetry selector is invalid");
      }
      const plan = buildFatigueTypingPlan(scenario.text, scenario.seed, scenario.profile);
      const result = await this.browser.simulateTyping({
        url,
        canonicalOrigin: this.policy.origin,
        selector: scenario.selector,
        timeoutMs: this.config.requestTimeoutMs,
        pointerSeed: scenario.seed ^ 0x5f3759df,
        pointerSteps: 30,
        plan,
      });
      uxTelemetry.push(result);
    }

    const finishedAtMs = this.clock.now();
    return Object.freeze({
      activationId: activation.activationId,
      canonicalOrigin: this.policy.origin,
      startedAtMs,
      finishedAtMs,
      pages: Object.freeze(pages),
      sitemap,
      uxTelemetry: Object.freeze(uxTelemetry),
      issues: Object.freeze(runIssues),
      summary: summary(runIssues, pages),
    });
  }
}
