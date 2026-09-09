import { describe, expect, it, vi } from "vitest";
import { CloudflareQueuesProducer, UpstashQStashFifoQueue, requireStrictFifoQueue } from "./runtime.js";

const event = {
  eventId: "idx:event:00000001",
  sequence: 7,
  pageUrl: "https://example.test/jobs/1",
  notificationType: "URL_UPDATED" as const,
  eligibility: "JOB_POSTING" as const,
  semanticReceiptDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-09-08T12:00:00.000Z",
};

describe("distributed SEO edge queues", () => {
  it("configures QStash queue parallelism 1 and enqueues with an idempotency key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/v2/queues")) return Response.json({});
      return Response.json({ messageId: "msg_123" });
    });
    const queue = new UpstashQStashFifoQueue({
      queueName: "indexing-fifo",
      destination: "https://example.test/internal/indexing",
      operatorWebsiteOrigin: "https://example.test",
      tokenProvider: async () => "token",
      fetchImpl,
    });
    expect(queue.identity()).toMatchObject({ operatorWebsiteOrigin: "https://example.test", ordering: "STRICT_FIFO" });
    await queue.ensureStrictFifo();
    await expect(queue.enqueue(event)).resolves.toEqual({ messageId: "msg_123" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ queueName: "indexing-fifo", parallelism: 1 });
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: "Bearer token",
      "Upstash-Deduplication-Id": "idx:event:00000001",
    });
    expect(requireStrictFifoQueue(queue).ordering).toBe("STRICT_FIFO");
  });

  it("exposes Cloudflare Queues as at-least-once unordered instead of claiming FIFO", async () => {
    const send = vi.fn(async () => undefined);
    const queue = new CloudflareQueuesProducer({ send }, "https://example.test");
    expect(queue.identity().operatorWebsiteOrigin).toBe("https://example.test");
    expect(queue.ordering).toBe("AT_LEAST_ONCE_UNORDERED");
    expect(() => queue.assertStrictFifo()).toThrow(/does not guarantee publish-order/u);
    expect(() => requireStrictFifoQueue(queue)).toThrow(/STRICT_FIFO/u);
    await queue.enqueue(event);
    expect(send).toHaveBeenCalledWith(event, { contentType: "json" });
  });

  it("rejects non-canonical or ineligible indexing events before enqueue", async () => {
    const queue = new CloudflareQueuesProducer({ send: async () => undefined }, "https://example.test");
    await expect(queue.enqueue({ ...event, pageUrl: "http://example.test/jobs/1" })).rejects.toThrow(/canonical HTTPS/u);
    await expect(queue.enqueue({ ...event, semanticReceiptDigest: "not-a-digest" })).rejects.toThrow(/receipt digest/u);
  });
});
