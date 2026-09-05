import { createSearchPerformanceSnapshot, type SearchPerformanceProvider, type SearchPerformanceRow, type SearchPerformanceSnapshot } from "./index";

const SEARCH_CONSOLE_BASE = "https://www.googleapis.com/webmasters/v3";
const MAX_API_ROW_LIMIT = 25_000;

export type GoogleSearchConsoleAccessTokenProvider = () => Promise<string>;

export class SearchConsoleApiError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "AUTHENTICATION_FAILED" | "QUOTA_EXHAUSTED" | "TIMEOUT" | "API_ERROR" | "INVALID_RESPONSE",
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "SearchConsoleApiError";
  }
}

export interface SearchConsoleRestClientConfig {
  readonly accessTokenProvider: GoogleSearchConsoleAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxReadRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface SearchConsoleRowPayload {
  readonly keys?: unknown;
  readonly clicks?: unknown;
  readonly impressions?: unknown;
  readonly ctr?: unknown;
  readonly position?: unknown;
}

function secret(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new SearchConsoleApiError("INVALID_CONFIG", `${field} is required`);
  return normalized;
}

function positiveInt(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new SearchConsoleApiError("INVALID_CONFIG", `${field} must be a positive safe integer <= ${max}`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchConsoleApiError("INVALID_RESPONSE", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new SearchConsoleApiError("INVALID_RESPONSE", `${field} must be finite and non-negative`);
  return value;
}

function finitePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new SearchConsoleApiError("INVALID_RESPONSE", `${field} must be finite and positive`);
  return value;
}

function ctr(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new SearchConsoleApiError("INVALID_RESPONSE", `${field} must be 0..1`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new SearchConsoleApiError("INVALID_RESPONSE", `${field} must be a string array`);
  return Object.freeze([...value] as string[]);
}

function googleMessage(payload: unknown): string {
  const root = optionalObject(payload);
  const error = optionalObject(root?.error);
  return typeof error?.message === "string" && error.message ? error.message.slice(0, 500) : "Search Console API request failed";
}

function googleStatus(payload: unknown): string | null {
  const root = optionalObject(payload);
  const error = optionalObject(root?.error);
  return typeof error?.status === "string" ? error.status : null;
}

function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1_000));
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.min(60_000, Math.max(0, absolute - nowMs)) : null;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class SearchConsoleRestClient implements SearchPerformanceProvider {
  private readonly accessTokenProvider: GoogleSearchConsoleAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(config: SearchConsoleRestClientConfig) {
    this.accessTokenProvider = config.accessTokenProvider;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    positiveInt(this.timeoutMs, "timeoutMs", 120_000);
    this.maxReadRetries = config.maxReadRetries ?? 2;
    if (!Number.isInteger(this.maxReadRetries) || this.maxReadRetries < 0 || this.maxReadRetries > 5) throw new SearchConsoleApiError("INVALID_CONFIG", "maxReadRetries must be 0..5");
    this.sleep = config.sleep ?? defaultSleep;
    this.now = config.now ?? Date.now;
  }

  private async request(siteUrl: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const attempts = this.maxReadRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const token = secret(await this.accessTokenProvider(), "OAuth access token");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        let payload: unknown = null;
        try { payload = await response.json(); } catch { payload = null; }
        if (response.ok) return object(payload ?? {}, "Search Console response");
        const status = googleStatus(payload);
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          const nowMs = this.now();
          await this.sleep(retryAfterMs(response.headers.get("retry-after"), nowMs) ?? Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        const code = response.status === 429 || status === "RESOURCE_EXHAUSTED"
          ? "QUOTA_EXHAUSTED"
          : response.status === 401 || response.status === 403
            ? "AUTHENTICATION_FAILED"
            : "API_ERROR";
        throw new SearchConsoleApiError(code, googleMessage(payload), response.status);
      } catch (error) {
        if (error instanceof SearchConsoleApiError) throw error;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (attempt + 1 < attempts) {
          await this.sleep(Math.min(8_000, 500 * 2 ** attempt));
          continue;
        }
        if (aborted) throw new SearchConsoleApiError("TIMEOUT", "Search Console request timed out");
        throw new SearchConsoleApiError("API_ERROR", "Search Console transport failed");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SearchConsoleApiError("API_ERROR", "Search Console retry loop exhausted");
  }

  private parseRows(payload: Record<string, unknown>, expectedKeys: number, expectQuery: boolean): readonly SearchPerformanceRow[] {
    if (payload.rows === undefined) return Object.freeze([]);
    if (!Array.isArray(payload.rows)) throw new SearchConsoleApiError("INVALID_RESPONSE", "Search Console rows must be an array");
    return Object.freeze(payload.rows.map((entry, index) => {
      const row = object(entry, `rows[${index}]`) as SearchConsoleRowPayload;
      const keys = strings(row.keys, `rows[${index}].keys`);
      if (keys.length !== expectedKeys) throw new SearchConsoleApiError("INVALID_RESPONSE", `rows[${index}] returned an unexpected key count`);
      const pageUrl = keys[0];
      if (!pageUrl) throw new SearchConsoleApiError("INVALID_RESPONSE", `rows[${index}] omitted page key`);
      const query = expectQuery ? keys[1] ?? null : null;
      if (expectQuery && !query) throw new SearchConsoleApiError("INVALID_RESPONSE", `rows[${index}] omitted query key`);
      return Object.freeze({
        pageUrl,
        query,
        clicks: finiteNonNegative(row.clicks, `rows[${index}].clicks`),
        impressions: finiteNonNegative(row.impressions, `rows[${index}].impressions`),
        ctr: ctr(row.ctr, `rows[${index}].ctr`),
        position: finitePositive(row.position, `rows[${index}].position`),
      });
    }));
  }

  private async paginate(
    siteUrl: string,
    baseBody: Record<string, unknown>,
    maxRows: number,
    expectedKeys: number,
    expectQuery: boolean,
  ): Promise<{ readonly rows: readonly SearchPerformanceRow[]; readonly truncated: boolean }> {
    const rows: SearchPerformanceRow[] = [];
    let startRow = 0;
    while (rows.length < maxRows) {
      const rowLimit = Math.min(MAX_API_ROW_LIMIT, maxRows - rows.length);
      const payload = await this.request(siteUrl, { ...baseBody, rowLimit, startRow });
      const page = this.parseRows(payload, expectedKeys, expectQuery);
      rows.push(...page);
      if (page.length < rowLimit) return Object.freeze({ rows: Object.freeze(rows), truncated: false });
      startRow += page.length;
      if (page.length === 0) return Object.freeze({ rows: Object.freeze(rows), truncated: false });
    }
    return Object.freeze({ rows: Object.freeze(rows), truncated: true });
  }

  async getPerformance(input: Readonly<{ siteUrl: string; pageUrl: string; startDate: string; endDate: string; maxRows: number }>): Promise<SearchPerformanceSnapshot> {
    const maxRows = positiveInt(input.maxRows, "maxRows", 250_000);
    const pageBudget = Math.max(1, Math.floor(maxRows / 2));
    const queryBudget = Math.max(1, maxRows - pageBudget);
    const common = {
      startDate: input.startDate,
      endDate: input.endDate,
      type: "web",
      aggregationType: "auto",
      dataState: "final",
    };
    const pageResult = await this.paginate(input.siteUrl, { ...common, dimensions: ["page"] }, pageBudget, 1, false);
    const queryResult = await this.paginate(input.siteUrl, {
      ...common,
      dimensions: ["page", "query"],
      dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "page", operator: "equals", expression: input.pageUrl }] }],
    }, queryBudget, 2, true);
    const observedMs = this.now();
    if (!Number.isFinite(observedMs)) throw new SearchConsoleApiError("INVALID_CONFIG", "clock returned a non-finite value");
    return createSearchPerformanceSnapshot({
      sourceId: "google-search-console",
      siteUrl: input.siteUrl,
      startDate: input.startDate,
      endDate: input.endDate,
      dataState: "FINAL",
      coverage: "TOP_ROWS_BOUNDED",
      truncated: pageResult.truncated || queryResult.truncated,
      observedAt: new Date(observedMs).toISOString(),
      pageRows: pageResult.rows,
      targetQueryRows: queryResult.rows,
    });
  }
}
