import { describe, expect, it, vi } from "vitest";
import { GoogleApisIndexingPublisher, createGoogleIndexingServerlessHandler } from "./runtime.js";

const event = {
  eventId: "idx:event:00000001",
  sequence: 7,
  pageUrl: "https://example.test/jobs/1",
  notificationType: "URL_UPDATED" as const,
  eligibility: "JOB_POSTING" as const,
  semanticReceiptDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-09-08T12:00:00.000Z",
};

describe("GoogleApisIndexingPublisher", () => {
  it("passes an eligible same-origin event to the googleapis Indexing client shape", async () => {
    const publish = vi.fn(async () => ({ data: { url: event.pageUrl } }));
    const publisher = new GoogleApisIndexingPublisher("https://example.test", { urlNotifications: { publish } });
    await expect(publisher.publish(event)).resolves.toMatchObject({ provider: "GOOGLE_INDEXING_API", accepted: true });
    expect(publish).toHaveBeenCalledWith({ requestBody: { url: "https://example.test/jobs/1", type: "URL_UPDATED" } });
  });

  it("rejects URLs outside the canonical operator origin before calling Google", async () => {
    const publish = vi.fn(async () => ({ data: {} }));
    const publisher = new GoogleApisIndexingPublisher("https://example.test", { urlNotifications: { publish } });
    await expect(publisher.publish({ ...event, pageUrl: "https://other.example/jobs/1" })).rejects.toThrow(/canonical operator origin/u);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects events without Google-supported structured-data eligibility", async () => {
    const publish = vi.fn(async () => ({ data: {} }));
    const publisher = new GoogleApisIndexingPublisher("https://example.test", { urlNotifications: { publish } });
    await expect(publisher.publish({ ...event, eligibility: "ARTICLE" as never })).rejects.toThrow(/restricted to JobPosting/u);
    expect(publish).not.toHaveBeenCalled();
  });

  it("protects the serverless consumer with an explicit internal authenticator", async () => {
    const publish = vi.fn(async () => ({ data: {} }));
    const publisher = new GoogleApisIndexingPublisher("https://example.test", { urlNotifications: { publish } });
    const denied = createGoogleIndexingServerlessHandler({ publisher, authenticator: { verify: async () => false } });
    const deniedResponse = await denied(new Request("https://example.test/internal/indexing", { method: "POST", body: JSON.stringify(event) }));
    expect(deniedResponse.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();

    const allowed = createGoogleIndexingServerlessHandler({ publisher, authenticator: { verify: async () => true } });
    const allowedResponse = await allowed(new Request("https://example.test/internal/indexing", { method: "POST", body: JSON.stringify(event) }));
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(publish).toHaveBeenCalledOnce();
  });
});
