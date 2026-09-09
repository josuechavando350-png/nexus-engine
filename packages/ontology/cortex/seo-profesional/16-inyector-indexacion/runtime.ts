import type { IndexingQueueEvent } from "../15-cola-fifo/index.js";

export interface GoogleApisIndexingClientPort {
  readonly urlNotifications: {
    publish(input: Readonly<{
      requestBody: Readonly<{
        url: string;
        type: "URL_UPDATED" | "URL_DELETED";
      }>;
    }>): Promise<Readonly<{ data?: unknown }>>;
  };
}

export interface IndexingRequestAuthenticator {
  verify(request: Request): Promise<boolean>;
}

export interface GoogleIndexingPublishReceipt {
  readonly eventId: string;
  readonly pageUrl: string;
  readonly notificationType: "URL_UPDATED" | "URL_DELETED";
  readonly eligibility: "JOB_POSTING" | "LIVESTREAM_BROADCAST_EVENT";
  readonly semanticReceiptDigest: string;
  readonly provider: "GOOGLE_INDEXING_API";
  readonly accepted: true;
}

export class GoogleIndexingError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "IDENTITY_MISMATCH"
      | "INELIGIBLE_PAGE"
      | "AUTHENTICATION_FAILED"
      | "PROVIDER_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "GoogleIndexingError";
  }
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function bareOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GoogleIndexingError("INVALID_CONFIG", "operatorWebsiteOrigin must be absolute");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new GoogleIndexingError("INVALID_CONFIG", "operatorWebsiteOrigin must be a bare HTTPS origin");
  }
  return url.origin;
}

function validateEvent(event: IndexingQueueEvent, operatorWebsiteOrigin: string): IndexingQueueEvent {
  if (!event || !EVENT_ID.test(event.eventId) || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
    throw new GoogleIndexingError("INVALID_INPUT", "indexing event id/sequence are malformed");
  }
  let page: URL;
  try {
    page = new URL(event.pageUrl);
  } catch {
    throw new GoogleIndexingError("INVALID_INPUT", "Indexing API URL is malformed");
  }
  if (page.protocol !== "https:" || page.origin !== operatorWebsiteOrigin || page.username || page.password || page.hash) {
    throw new GoogleIndexingError("IDENTITY_MISMATCH", "Indexing API URL must belong to the canonical operator origin");
  }
  if (event.notificationType !== "URL_UPDATED" && event.notificationType !== "URL_DELETED") {
    throw new GoogleIndexingError("INVALID_INPUT", "Indexing API notification type is invalid");
  }
  if (event.eligibility !== "JOB_POSTING" && event.eligibility !== "LIVESTREAM_BROADCAST_EVENT") {
    throw new GoogleIndexingError("INELIGIBLE_PAGE", "Google Indexing API is restricted to JobPosting or eligible livestream BroadcastEvent pages");
  }
  if (!DIGEST.test(event.semanticReceiptDigest)) {
    throw new GoogleIndexingError("INVALID_INPUT", "semantic receipt digest is malformed");
  }
  const createdAt = new Date(event.createdAt);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== event.createdAt) {
    throw new GoogleIndexingError("INVALID_INPUT", "indexing event createdAt must be canonical UTC");
  }
  return Object.freeze({ ...event, pageUrl: page.href });
}

export class GoogleApisIndexingPublisher {
  private readonly operatorWebsiteOrigin: string;

  constructor(
    operatorWebsiteOrigin: string,
    private readonly client: GoogleApisIndexingClientPort,
  ) {
    if (!client?.urlNotifications || typeof client.urlNotifications.publish !== "function") {
      throw new GoogleIndexingError("INVALID_CONFIG", "official googleapis Indexing client is required");
    }
    this.operatorWebsiteOrigin = bareOrigin(operatorWebsiteOrigin);
  }

  identity() {
    return Object.freeze({
      strategy: 16 as const,
      provider: "GOOGLE_INDEXING_API" as const,
      sdkBoundary: "GOOGLEAPIS_NODE_SERVERLESS" as const,
      operatorWebsiteOrigin: this.operatorWebsiteOrigin,
      eligibleTypes: Object.freeze(["JOB_POSTING", "LIVESTREAM_BROADCAST_EVENT"] as const),
    });
  }

  async publish(eventInput: IndexingQueueEvent): Promise<GoogleIndexingPublishReceipt> {
    const event = validateEvent(eventInput, this.operatorWebsiteOrigin);
    try {
      await this.client.urlNotifications.publish({
        requestBody: {
          url: event.pageUrl,
          type: event.notificationType,
        },
      });
    } catch (error) {
      throw new GoogleIndexingError(
        "PROVIDER_FAILURE",
        `Google Indexing API publish failed: ${error instanceof Error ? error.message : "unknown provider error"}`,
      );
    }
    return Object.freeze({
      eventId: event.eventId,
      pageUrl: event.pageUrl,
      notificationType: event.notificationType,
      eligibility: event.eligibility,
      semanticReceiptDigest: event.semanticReceiptDigest,
      provider: "GOOGLE_INDEXING_API" as const,
      accepted: true as const,
    });
  }
}

export function createGoogleIndexingServerlessHandler(input: Readonly<{
  publisher: GoogleApisIndexingPublisher;
  authenticator: IndexingRequestAuthenticator;
  maxBodyBytes?: number;
}>): (request: Request) => Promise<Response> {
  if (!input?.publisher || typeof input.publisher.publish !== "function" || !input.authenticator || typeof input.authenticator.verify !== "function") {
    throw new GoogleIndexingError("INVALID_CONFIG", "indexing publisher/authenticator are required");
  }
  const maxBodyBytes = input.maxBodyBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 256 * 1024) {
    throw new GoogleIndexingError("INVALID_CONFIG", "maxBodyBytes is invalid");
  }
  const encoder = new TextEncoder();

  return async (request: Request): Promise<Response> => {
    const headers = { "cache-control": "private, no-store", "content-type": "application/json; charset=utf-8" };
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), { status: 405, headers: { ...headers, allow: "POST" } });
    if (!(await input.authenticator.verify(request))) {
      return new Response(JSON.stringify({ error: "AUTHENTICATION_FAILED" }), { status: 401, headers });
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return new Response(JSON.stringify({ error: "BODY_TOO_LARGE" }), { status: 413, headers });
    }
    const text = await request.text();
    if (encoder.encode(text).byteLength > maxBodyBytes) {
      return new Response(JSON.stringify({ error: "BODY_TOO_LARGE" }), { status: 413, headers });
    }
    let event: IndexingQueueEvent;
    try {
      event = JSON.parse(text) as IndexingQueueEvent;
    } catch {
      return new Response(JSON.stringify({ error: "INVALID_JSON" }), { status: 400, headers });
    }
    try {
      const receipt = await input.publisher.publish(event);
      return new Response(JSON.stringify(receipt), { status: 200, headers });
    } catch (error) {
      if (error instanceof GoogleIndexingError && ["INVALID_INPUT", "IDENTITY_MISMATCH", "INELIGIBLE_PAGE"].includes(error.code)) {
        return new Response(JSON.stringify({ error: error.code }), { status: 422, headers });
      }
      throw error;
    }
  };
}
