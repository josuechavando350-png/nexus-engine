import { describe, expect, it } from "vitest";
import { observeHttpFetchAsGooglebot, simulateGooglebotRender } from "../googlebot-runtime.js";

describe("Googlebot runtime safety", () => {
  it("blocks private IPv4 HTTP fetch targets before network access", async () => {
    const evidence = await observeHttpFetchAsGooglebot("http://127.0.0.1/private", {
      clock: () => new Date("2026-08-31T05:00:00.000Z"),
      timeoutMs: 500,
    });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.source).toBe("OBSERVED_HTTP_FETCH");
    expect(evidence.reason).toMatch(/private or reserved ipv4 target is blocked/i);
    expect(evidence.htmlDigest).toBeNull();
  });

  it("blocks localhost browser simulation before Chromium can navigate", async () => {
    const evidence = await simulateGooglebotRender("http://localhost:3000/", {
      clock: () => new Date("2026-08-31T05:00:00.000Z"),
      timeoutMs: 500,
    });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.source).toBe("SIMULATED_BROWSER");
    expect(evidence.reason).toMatch(/local hostname is blocked/);
    expect(evidence.screenshotDigest).toBeNull();
  });

  it("fails closed when runtime work is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const evidence = await observeHttpFetchAsGooglebot("https://example.com/", {
      signal: controller.signal,
      clock: () => new Date("2026-08-31T05:00:00.000Z"),
      timeoutMs: 500,
    });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.reason).toMatch(/cancelled/);
  });

  it("rejects unsafe runtime budgets instead of widening them", async () => {
    await expect(observeHttpFetchAsGooglebot("https://example.com/", { maxResponseBytes: 64 * 1024 * 1024 })).rejects.toThrow(/maxResponseBytes/);
    await expect(simulateGooglebotRender("https://example.com/", { maxObservedHosts: 10_000 })).rejects.toThrow(/maxObservedHosts/);
  });
});
