export type SeoAuditSeverity = "INFO" | "WARNING" | "ERROR";

export type SeoAuditCategory =
  | "CRAWL"
  | "INDEXABILITY"
  | "METADATA"
  | "CONTENT"
  | "LINKS"
  | "STRUCTURED_DATA"
  | "SITEMAP"
  | "UX_TELEMETRY";

export interface SeoAuditIssue {
  readonly code: string;
  readonly severity: SeoAuditSeverity;
  readonly category: SeoAuditCategory;
  readonly url: string;
  readonly message: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SeoAuditLinkSnapshot {
  readonly href: string;
  readonly rel: string;
  readonly text: string;
}

export interface SeoAuditImageSnapshot {
  readonly src: string;
  readonly alt: string | null;
}

export interface SeoAuditHeadingSnapshot {
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
}

export interface SeoAuditPageSnapshot {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly title: string;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly robotsMeta: string | null;
  readonly xRobotsTag: string | null;
  readonly language: string | null;
  readonly headings: readonly SeoAuditHeadingSnapshot[];
  readonly links: readonly SeoAuditLinkSnapshot[];
  readonly images: readonly SeoAuditImageSnapshot[];
  readonly jsonLdBlocks: readonly string[];
  readonly textLength: number;
  readonly responseTimeMs: number;
}

export interface SeoAuditBrowserInspectRequest {
  readonly url: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly canonicalOrigin: string;
}

export interface SeoAuditBrowserPort {
  inspect(request: SeoAuditBrowserInspectRequest): Promise<SeoAuditPageSnapshot>;
  simulateTyping?(request: SeoAuditTypingSimulationRequest): Promise<SeoAuditTypingSimulationResult>;
}

export interface SeoAuditHttpResponse {
  readonly status: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  text(): Promise<string>;
}

export interface SeoAuditHttpPort {
  fetch(url: string, init: Readonly<{ userAgent: string; timeoutMs: number }>): Promise<SeoAuditHttpResponse>;
}

export interface SeoAuditClockPort {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SeoAuditRuntimeConfig {
  readonly canonicalOrigin: string;
  readonly userAgent: string;
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly requestTimeoutMs: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly sitemapUrls?: readonly string[];
}

export interface SeoAuditActivationRequest {
  readonly requestedBy: string;
  readonly reason: string;
  readonly expiresAtMs?: number;
}

export interface SeoAuditActivationReceipt {
  readonly activationId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly activatedAtMs: number;
  readonly expiresAtMs: number | null;
}

export interface SeoAuditTypingProfile {
  readonly minKeyDelayMs: number;
  readonly maxKeyDelayMs: number;
  readonly correctionRate: number;
  readonly pauseEveryChars: number;
  readonly minPauseMs: number;
  readonly maxPauseMs: number;
}

export type SeoAuditTypingAction =
  | Readonly<{ type: "WAIT"; ms: number }>
  | Readonly<{ type: "TYPE"; value: string }>
  | Readonly<{ type: "BACKSPACE" }>;

export interface SeoAuditTypingSimulationRequest {
  readonly url: string;
  readonly canonicalOrigin: string;
  readonly selector: string;
  readonly timeoutMs: number;
  readonly pointerSeed: number;
  readonly pointerSteps: number;
  readonly plan: readonly SeoAuditTypingAction[];
}

export interface SeoAuditTypingSimulationResult {
  readonly url: string;
  readonly selector: string;
  readonly typedCharacters: number;
  readonly corrections: number;
  readonly elapsedMs: number;
  readonly submitted: false;
}

export interface SeoAuditUxScenario {
  readonly url: string;
  readonly selector: string;
  readonly text: string;
  readonly seed: number;
  readonly profile?: Partial<SeoAuditTypingProfile>;
}

export interface SeoAuditRunInput {
  readonly startUrls: readonly string[];
  readonly uxScenarios?: readonly SeoAuditUxScenario[];
}

export interface SeoAuditPageReport {
  readonly url: string;
  readonly status: number;
  readonly indexable: boolean;
  readonly depth: number;
  readonly discoveredFrom: string | null;
  readonly issues: readonly SeoAuditIssue[];
  readonly snapshot: SeoAuditPageSnapshot;
}

export interface SeoAuditSitemapReport {
  readonly discoveredSitemaps: readonly string[];
  readonly urls: readonly string[];
  readonly issues: readonly SeoAuditIssue[];
}

export interface SeoAuditRunReport {
  readonly activationId: string;
  readonly canonicalOrigin: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly pages: readonly SeoAuditPageReport[];
  readonly sitemap: SeoAuditSitemapReport;
  readonly uxTelemetry: readonly SeoAuditTypingSimulationResult[];
  readonly issues: readonly SeoAuditIssue[];
  readonly summary: Readonly<{
    crawledPages: number;
    indexablePages: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  }>;
}
