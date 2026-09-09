export interface LinkMatrixEntry {
  readonly href: string;
  readonly label: string;
}

export interface LinkMatrixRecord {
  readonly version: number;
  readonly updatedAt: string;
  readonly links: readonly LinkMatrixEntry[];
}

export interface LinkMatrixStorePort {
  readonly provider: "CLOUDFLARE_WORKERS_KV" | "UPSTASH_REDIS_REST";
  get(key: string, signal?: AbortSignal): Promise<LinkMatrixRecord | null>;
  put(key: string, value: LinkMatrixRecord, signal?: AbortSignal): Promise<void>;
}

export interface CloudflareKvBinding {
  get(key: string, options?: Readonly<{ cacheTtl?: number }>): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export class LinkMatrixError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "IDENTITY_MISMATCH" | "STORE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "LinkMatrixError";
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,191}$/u;
const enc = new TextEncoder();

function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkMatrixError("INVALID_CONFIG", "operatorWebsiteOrigin must be absolute");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new LinkMatrixError("INVALID_CONFIG", "operatorWebsiteOrigin must be a bare HTTPS origin");
  }
  return url.origin;
}

function matrixKey(raw: string): string {
  const value = raw.trim();
  if (!KEY.test(value)) throw new LinkMatrixError("INVALID_INPUT", "link matrix key is malformed");
  return value;
}

function canonicalUtc(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new LinkMatrixError("INVALID_INPUT", "updatedAt must be canonical ISO-8601 UTC");
  }
  return value;
}

function validateRecord(value: unknown): LinkMatrixRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LinkMatrixError("STORE_FAILURE", "link matrix record is malformed");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1 || !Array.isArray(record.links)) {
    throw new LinkMatrixError("STORE_FAILURE", "link matrix version/links are malformed");
  }
  const links = record.links.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new LinkMatrixError("STORE_FAILURE", "link matrix entry is malformed");
    const item = entry as Record<string, unknown>;
    if (typeof item.href !== "string" || typeof item.label !== "string") throw new LinkMatrixError("STORE_FAILURE", "link matrix href/label are malformed");
    return Object.freeze({ href: item.href, label: item.label });
  });
  if (typeof record.updatedAt !== "string") throw new LinkMatrixError("STORE_FAILURE", "link matrix updatedAt is malformed");
  return Object.freeze({ version: record.version as number, updatedAt: canonicalUtc(record.updatedAt), links: Object.freeze(links) });
}

export class CloudflareKvLinkMatrixStore implements LinkMatrixStorePort {
  readonly provider = "CLOUDFLARE_WORKERS_KV" as const;

  constructor(
    private readonly kv: CloudflareKvBinding,
    private readonly cacheTtlSeconds = 30,
  ) {
    if (!kv || typeof kv.get !== "function" || typeof kv.put !== "function" || !Number.isSafeInteger(cacheTtlSeconds) || cacheTtlSeconds < 30 || cacheTtlSeconds > 86_400) {
      throw new LinkMatrixError("INVALID_CONFIG", "Workers KV binding/cache TTL are invalid");
    }
  }

  async get(keyInput: string): Promise<LinkMatrixRecord | null> {
    const raw = await this.kv.get(matrixKey(keyInput), { cacheTtl: this.cacheTtlSeconds });
    if (raw === null) return null;
    try {
      return validateRecord(JSON.parse(raw));
    } catch (error) {
      if (error instanceof LinkMatrixError) throw error;
      throw new LinkMatrixError("STORE_FAILURE", "Workers KV returned invalid JSON");
    }
  }

  async put(keyInput: string, value: LinkMatrixRecord): Promise<void> {
    await this.kv.put(matrixKey(keyInput), JSON.stringify(validateRecord(value)));
  }
}

export class UpstashRedisRestLinkMatrixStore implements LinkMatrixStorePort {
  readonly provider = "UPSTASH_REDIS_REST" as const;
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: () => Promise<string>;

  constructor(input: Readonly<{
    endpoint: string;
    tokenProvider: () => Promise<string>;
    fetchImpl?: typeof fetch;
  }>) {
    this.endpoint = new URL(input.endpoint);
    if (this.endpoint.protocol !== "https:" || this.endpoint.username || this.endpoint.password || typeof input.tokenProvider !== "function") {
      throw new LinkMatrixError("INVALID_CONFIG", "Upstash Redis endpoint/token provider are invalid");
    }
    this.tokenProvider = input.tokenProvider;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async command(command: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const token = (await this.tokenProvider()).trim();
    if (!token) throw new LinkMatrixError("INVALID_CONFIG", "Upstash Redis token is empty");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal,
    });
    if (!response.ok) throw new LinkMatrixError("STORE_FAILURE", `Upstash Redis returned HTTP ${response.status}`);
    const body = await response.json() as { result?: unknown; error?: unknown };
    if (body.error !== undefined) throw new LinkMatrixError("STORE_FAILURE", "Upstash Redis command failed");
    return body.result;
  }

  async get(keyInput: string, signal?: AbortSignal): Promise<LinkMatrixRecord | null> {
    const result = await this.command(["GET", matrixKey(keyInput)], signal);
    if (result === null) return null;
    if (typeof result !== "string") throw new LinkMatrixError("STORE_FAILURE", "Upstash Redis GET returned a non-string value");
    try {
      return validateRecord(JSON.parse(result));
    } catch (error) {
      if (error instanceof LinkMatrixError) throw error;
      throw new LinkMatrixError("STORE_FAILURE", "Upstash Redis returned invalid JSON");
    }
  }

  async put(keyInput: string, value: LinkMatrixRecord, signal?: AbortSignal): Promise<void> {
    const result = await this.command(["SET", matrixKey(keyInput), JSON.stringify(validateRecord(value))], signal);
    if (result !== "OK") throw new LinkMatrixError("STORE_FAILURE", "Upstash Redis SET was not acknowledged");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

const EXISTING_MATRIX = /<nav\b[^>]*\bdata-nexus-link-matrix=(?:"v1"|'v1')[^>]*>[\s\S]*?<\/nav\s*>/giu;
const MARKER = "<!-- NEXUS_LINK_MATRIX -->";

export class EdgeCompiledLinkMatrix {
  private readonly operatorWebsiteOrigin: string;

  constructor(
    private readonly store: LinkMatrixStorePort,
    operatorWebsiteOrigin: string,
    private readonly maxLinks = 64,
  ) {
    if (!store || typeof store.get !== "function" || typeof store.put !== "function" || !Number.isSafeInteger(maxLinks) || maxLinks < 1 || maxLinks > 200) {
      throw new LinkMatrixError("INVALID_CONFIG", "link matrix store/maxLinks are invalid");
    }
    this.operatorWebsiteOrigin = normalizeOrigin(operatorWebsiteOrigin);
  }

  identity() {
    return Object.freeze({
      strategy: 14 as const,
      provider: "EDGE_COMPILED_LINK_MATRIX" as const,
      storeProvider: this.store.provider,
      operatorWebsiteOrigin: this.operatorWebsiteOrigin,
    });
  }

  normalizeRecord(record: LinkMatrixRecord): LinkMatrixRecord {
    const validated = validateRecord(record);
    if (validated.links.length > this.maxLinks) throw new LinkMatrixError("INVALID_INPUT", "link matrix exceeds maxLinks");
    const seen = new Set<string>();
    const links = validated.links.map((entry) => {
      const label = entry.label.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (!label || enc.encode(label).byteLength > 256) throw new LinkMatrixError("INVALID_INPUT", "link label is empty or too long");
      let url: URL;
      try {
        url = new URL(entry.href, `${this.operatorWebsiteOrigin}/`);
      } catch {
        throw new LinkMatrixError("INVALID_INPUT", "link href is malformed");
      }
      if (url.protocol !== "https:" || url.origin !== this.operatorWebsiteOrigin || url.username || url.password) {
        throw new LinkMatrixError("IDENTITY_MISMATCH", "link matrix may contain only same-origin HTTPS URLs");
      }
      url.hash = "";
      const href = `${url.pathname}${url.search}`;
      if (seen.has(href)) throw new LinkMatrixError("INVALID_INPUT", "link matrix contains duplicate URLs");
      seen.add(href);
      return Object.freeze({ href, label });
    });
    return Object.freeze({ version: validated.version, updatedAt: validated.updatedAt, links: Object.freeze(links) });
  }

  async publish(key: string, record: LinkMatrixRecord, signal?: AbortSignal): Promise<void> {
    await this.store.put(matrixKey(key), this.normalizeRecord(record), signal);
  }

  async inject(
    key: string,
    requestUrlInput: string,
    htmlInput: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ html: string; linkCount: number; matrixVersion: number | null; storeProvider: LinkMatrixStorePort["provider"] }>> {
    const requestUrl = new URL(requestUrlInput);
    if (requestUrl.protocol !== "https:" || requestUrl.origin !== this.operatorWebsiteOrigin) {
      throw new LinkMatrixError("IDENTITY_MISMATCH", "request URL must use the canonical operator origin");
    }
    if (!htmlInput || htmlInput.length > 2 * 1024 * 1024) throw new LinkMatrixError("INVALID_INPUT", "HTML is empty or exceeds 2 MiB");
    const record = await this.store.get(matrixKey(key), signal);
    if (record === null) return Object.freeze({ html: htmlInput, linkCount: 0, matrixVersion: null, storeProvider: this.store.provider });
    const normalized = this.normalizeRecord(record);
    const links = normalized.links
      .filter((entry) => entry.href !== `${requestUrl.pathname}${requestUrl.search}`)
      .map((entry) => `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.label)}</a>`)
      .join("");
    const nav = `<nav data-nexus-link-matrix="v1" aria-label="Related pages">${links}</nav>`;
    let html = htmlInput.replace(EXISTING_MATRIX, "");
    if (html.includes(MARKER)) html = html.replace(MARKER, nav);
    else if (/<\/body\s*>/iu.test(html)) html = html.replace(/<\/body\s*>/iu, `${nav}</body>`);
    else throw new LinkMatrixError("INVALID_INPUT", "HTML must contain the link-matrix marker or closing body");
    return Object.freeze({ html, linkCount: normalized.links.length, matrixVersion: normalized.version, storeProvider: this.store.provider });
  }
}
