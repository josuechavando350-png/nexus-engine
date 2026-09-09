export type EdgeQueueOrdering = "STRICT_FIFO" | "AT_LEAST_ONCE_UNORDERED";

export interface IndexingQueueEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly pageUrl: string;
  readonly notificationType: "URL_UPDATED" | "URL_DELETED";
  readonly eligibility: "JOB_POSTING" | "LIVESTREAM_BROADCAST_EVENT";
  readonly semanticReceiptDigest: string;
  readonly createdAt: string;
}

export interface DistributedEdgeQueuePort {
  readonly provider: "UPSTASH_QSTASH_FIFO" | "CLOUDFLARE_QUEUES";
  readonly ordering: EdgeQueueOrdering;
  enqueue(event: IndexingQueueEvent, signal?: AbortSignal): Promise<Readonly<{ messageId: string | null }>>;
}

export interface CloudflareQueueBinding {
  send(body: unknown, options?: Readonly<{ contentType?: "json" | "text" | "bytes" | "v8" }>): Promise<void>;
}

export class EdgeQueueError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "ORDERING_UNSUPPORTED" | "PROVIDER_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "EdgeQueueError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function canonicalEvent(event: IndexingQueueEvent): IndexingQueueEvent {
  if (!event || !ID.test(event.eventId) || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new EdgeQueueError("INVALID_INPUT", "queue event id/sequence are malformed");
  }
  let page: URL;
  try {
    page = new URL(event.pageUrl);
  } catch {
    throw new EdgeQueueError("INVALID_INPUT", "queue event pageUrl is malformed");
  }
  if (page.protocol !== "https:" || page.username || page.password || page.hash) {
    throw new EdgeQueueError("INVALID_INPUT", "queue event pageUrl must be canonical HTTPS");
  }
  if (event.notificationType !== "URL_UPDATED" && event.notificationType !== "URL_DELETED") {
    throw new EdgeQueueError("INVALID_INPUT", "queue event notification type is invalid");
  }
  if (event.eligibility !== "JOB_POSTING" && event.eligibility !== "LIVESTREAM_BROADCAST_EVENT") {
    throw new EdgeQueueError("INVALID_INPUT", "queue event indexing eligibility is invalid");
  }
  if (!DIGEST.test(event.semanticReceiptDigest)) {
    throw new EdgeQueueError("INVALID_INPUT", "queue event semantic receipt digest is invalid");
  }
  const createdAt = new Date(event.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== event.createdAt) {
    throw new EdgeQueueError("INVALID_INPUT", "queue event createdAt must be canonical UTC");
  }
  return Object.freeze({ ...event, pageUrl: page.href });
}

function httpsEndpoint(raw: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EdgeQueueError("INVALID_CONFIG", `${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new EdgeQueueError("INVALID_CONFIG", `${field} must use HTTPS without credentials`);
  }
  return url;
}

export class UpstashQStashFifoQueue implements DistributedEdgeQueuePort {
  readonly provider = "UPSTASH_QSTASH_FIFO" as const;
  readonly ordering = "STRICT_FIFO" as const;
  private readonly apiBase: URL;
  private readonly destination: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly queueName: string;
  private readonly tokenProvider: () => Promise<string>;

  constructor(input: Readonly<{
    queueName: string;
    destination: string;
    tokenProvider: () => Promise<string>;
    apiBase?: string;
    fetchImpl?: typeof fetch;
  }>) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(input.queueName) || typeof input.tokenProvider !== "function") {
      throw new EdgeQueueError("INVALID_CONFIG", "QStash queueName/tokenProvider are invalid");
    }
    this.queueName = input.queueName;
    this.destination = httpsEndpoint(input.destination, "destination");
    this.apiBase = httpsEndpoint(input.apiBase ?? "https://qstash.upstash.io", "apiBase");
    this.tokenProvider = input.tokenProvider;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  identity(operatorWebsiteOrigin: string) {
    return Object.freeze({
      strategy: 15 as const,
      provider: this.provider,
      ordering: this.ordering,
      operatorWebsiteOrigin,
    });
  }

  private async token(): Promise<string> {
    const token = (await this.tokenProvider()).trim();
    if (!token) throw new EdgeQueueError("INVALID_CONFIG", "QStash token is empty");
    return token;
  }

  async ensureStrictFifo(signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(new URL("/v2/queues", this.apiBase), {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ queueName: this.queueName, parallelism: 1 }),
      signal,
    });
    if (!response.ok) throw new EdgeQueueError("PROVIDER_FAILURE", `QStash queue upsert returned HTTP ${response.status}`);
  }

  async enqueue(eventInput: IndexingQueueEvent, signal?: AbortSignal): Promise<Readonly<{ messageId: string | null }>> {
    const event = canonicalEvent(eventInput);
    const endpoint = new URL(`/v2/enqueue/${encodeURIComponent(this.queueName)}/${encodeURIComponent(this.destination.href)}`, this.apiBase);
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
        "Upstash-Method": "POST",
        "Upstash-Deduplication-Id": event.eventId,
      },
      body: JSON.stringify(event),
      signal,
    });
    if (!response.ok) throw new EdgeQueueError("PROVIDER_FAILURE", `QStash enqueue returned HTTP ${response.status}`);
    let messageId: string | null = null;
    try {
      const body = await response.json() as { messageId?: unknown };
      if (typeof body.messageId === "string" && body.messageId.trim()) messageId = body.messageId;
    } catch {
      // HTTP success is the enqueue acknowledgement even if the response body is absent.
    }
    return Object.freeze({ messageId });
  }
}

export class CloudflareQueuesProducer implements DistributedEdgeQueuePort {
  readonly provider = "CLOUDFLARE_QUEUES" as const;
  readonly ordering = "AT_LEAST_ONCE_UNORDERED" as const;

  constructor(private readonly queue: CloudflareQueueBinding) {
    if (!queue || typeof queue.send !== "function") throw new EdgeQueueError("INVALID_CONFIG", "Cloudflare Queue binding is required");
  }

  identity(operatorWebsiteOrigin: string) {
    return Object.freeze({
      strategy: 15 as const,
      provider: this.provider,
      ordering: this.ordering,
      operatorWebsiteOrigin,
    });
  }

  assertStrictFifo(): never {
    throw new EdgeQueueError(
      "ORDERING_UNSUPPORTED",
      "Cloudflare Queues does not guarantee publish-order delivery; use QStash Queue with parallelism 1 for STRICT_FIFO",
    );
  }

  async enqueue(eventInput: IndexingQueueEvent, signal?: AbortSignal): Promise<Readonly<{ messageId: null }>> {
    const event = canonicalEvent(eventInput);
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    await this.queue.send(event, { contentType: "json" });
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    return Object.freeze({ messageId: null });
  }
}

export function requireStrictFifoQueue(queue: DistributedEdgeQueuePort): DistributedEdgeQueuePort & { readonly ordering: "STRICT_FIFO" } {
  if (queue.ordering !== "STRICT_FIFO" || queue.provider !== "UPSTASH_QSTASH_FIFO") {
    throw new EdgeQueueError("ORDERING_UNSUPPORTED", "the indexing event chain requires a provider with documented STRICT_FIFO ordering");
  }
  return queue as DistributedEdgeQueuePort & { readonly ordering: "STRICT_FIFO" };
}
