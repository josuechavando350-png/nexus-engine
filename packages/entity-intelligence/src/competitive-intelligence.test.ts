import { describe, expect, it, vi } from "vitest";
import { digest } from "./index";
import { analyzeCompetitiveIntelligence, capturePublicPage, createControlledPublicPageObservation, verifyCompetitiveIntelligence, type CompetitiveScope } from "./competitive-intelligence";
import { runCompetitiveIntelligence } from "./competitive-intelligence-runtime";

const scope: CompetitiveScope = { tenantId: "tenant-a", organizationId: "org-a", brandId: "brand-a" };
const observedAt = "2026-08-31T09:10:00.000Z";
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as const;

function controlled(url: string, terms: string[], observationScope: CompetitiveScope = scope) {
  return createControlledPublicPageObservation({
    scope: observationScope,
    url,
    finalUrl: url,
    observedAt,
    status: 200,
    title: "Example",
    description: "Example description",
    canonicalUrl: url,
    visibleTerms: terms,
    bodyDigest: digest(`<html>${terms.join(" ")}</html>`),
  });
}

describe("competitive intelligence", () => {
  it("keeps injected transport captures explicitly synthetic while exercising extraction", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html><head><title>Competitor</title><meta name=\"description\" content=\"Fast legal service\"><link rel=\"canonical\" href=\"/canonical\"></head><body>Legal strategy strategy pricing</body></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const observation = await capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl, lookup: publicLookup });
    expect(observation.authority).toBe("CONTROLLED_TEST");
    expect(observation.scope).toEqual(scope);
    expect(observation.title).toBe("Competitor");
    expect(observation.description).toBe("Fast legal service");
    expect(observation.canonicalUrl).toBe("https://example.com/canonical");
    expect(observation.visibleTerms).toContain("strategy");
  });

  it("blocks SSRF to private addresses before transport and revalidates redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    await expect(capturePublicPage("http://127.0.0.1/private", observedAt, { scope, fetchImpl })).rejects.toThrow(/private or reserved/);
    expect(fetchImpl).not.toHaveBeenCalled();

    const redirectFetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/secret" } })) as unknown as typeof fetch;
    await expect(capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl: redirectFetch, lookup: publicLookup })).rejects.toThrow(/private or reserved/);
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });

  it("honestly labels controlled comparisons synthetic and detects report tampering", () => {
    const target = { id: "self", label: "Self", observation: controlled("https://self.example/", ["legal", "service"]) };
    const competitors = [
      { id: "c1", label: "C1", observation: controlled("https://c1.example/", ["legal", "pricing", "strategy"]) },
      { id: "c2", label: "C2", observation: controlled("https://c2.example/", ["pricing", "strategy", "fast"]) },
    ];
    const report = analyzeCompetitiveIntelligence(scope, target, competitors);
    expect(report.evidenceState).toBe("SYNTHETIC");
    expect(report.gaps.slice(0, 2).map((gap) => gap.term)).toEqual(["pricing", "strategy"]);
    expect(verifyCompetitiveIntelligence(scope, target, competitors, report)).toBe(true);
    const tampered = structuredClone(report);
    (tampered.gaps[0] as { competitorCount: number }).competitorCount = 99;
    expect(verifyCompetitiveIntelligence(scope, target, competitors, tampered)).toBe(false);
  });

  it("rejects cross-tenant observations even when their evidence is otherwise valid", () => {
    const otherScope: CompetitiveScope = { tenantId: "tenant-b", organizationId: "org-b", brandId: "brand-b" };
    const target = { id: "self", label: "Self", observation: controlled("https://self.example/", ["legal"]) };
    const competitor = { id: "c1", label: "C1", observation: controlled("https://c1.example/", ["strategy"], otherScope) };
    expect(() => analyzeCompetitiveIntelligence(scope, target, [competitor])).toThrow(/scope mismatch/);
  });

  it("rejects forged live authority rather than upgrading controlled evidence", () => {
    const synthetic = controlled("https://competitor.example/", ["strategy"]);
    const forgedLive = { ...controlled("https://self.example/", ["legal"]), authority: "PUBLIC_HTTP_CAPTURE" as const };
    expect(() => analyzeCompetitiveIntelligence(scope, { id: "self", label: "Self", observation: forgedLive }, [{ id: "c", label: "C", observation: synthetic }])).toThrow(/replay mismatch/);
  });

  it("rejects a forged live observation even when an attacker recomputes its public digest", () => {
    const source = controlled("https://self.example/", ["legal"]);
    const { observationDigest: discardedDigest, ...controlledCore } = source;
    expect(discardedDigest).toMatch(/^[a-f0-9]{64}$/u);
    const forgedCore = { ...controlledCore, authority: "PUBLIC_HTTP_CAPTURE" as const };
    const forgedLive = { ...forgedCore, observationDigest: digest(forgedCore) };
    const competitorSource = controlled("https://competitor.example/", ["strategy"]);
    const { observationDigest: discardedCompetitorDigest, ...competitorControlledCore } = competitorSource;
    expect(discardedCompetitorDigest).toMatch(/^[a-f0-9]{64}$/u);
    const competitorForgedCore = { ...competitorControlledCore, authority: "PUBLIC_HTTP_CAPTURE" as const };
    const competitorForgedLive = { ...competitorForgedCore, observationDigest: digest(competitorForgedCore) };
    expect(() => analyzeCompetitiveIntelligence(scope, { id: "self", label: "Self", observation: forgedLive }, [{ id: "c", label: "C", observation: competitorForgedLive }])).toThrow(/attest|authority|live/i);
  });

  it("bounds capture execution with timeout and caller cancellation", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
    await expect(capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl, lookup: publicLookup, timeoutMs: 100 })).rejects.toThrow(/aborted/);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl, lookup: publicLookup, signal: controller.signal })).rejects.toThrow();
  });

  it("bounds stalled DNS resolution with the same capture deadline", async () => {
    const stalledLookup = vi.fn(async () => new Promise<readonly { address: string; family: number }[]>(() => undefined));
    const fetchImpl = vi.fn(async () => new Response("should not run")) as unknown as typeof fetch;
    await expect(capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl, lookup: stalledLookup, timeoutMs: 100 })).rejects.toThrow(/competitive capture timeout/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when timeout or caller cancellation interrupts a stalled response body", async () => {
    const stalledFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() { /* intentionally stalled */ } }), { status: 200 })) as unknown as typeof fetch;
    await expect(capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl: stalledFetch, lookup: publicLookup, timeoutMs: 100 })).rejects.toThrow(/competitive capture timeout/);

    const controller = new AbortController();
    const capture = capturePublicPage("https://example.com/", observedAt, { scope, fetchImpl: stalledFetch, lookup: publicLookup, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("caller cancelled stalled body")), 10);
    await expect(capture).rejects.toThrow(/caller cancelled stalled body/);
  });

  it("validates tenant scope before the runtime can perform public capture", async () => {
    await expect(runCompetitiveIntelligence({
      scope: { tenantId: "", organizationId: "org-a", brandId: "brand-a" },
      observedAt,
      target: { id: "self", label: "Self", url: "http://127.0.0.1/private" },
      competitors: [{ id: "c1", label: "C1", url: "http://127.0.0.1/private" }],
    })).rejects.toThrow(/scope\.tenantId/);
  });
});
