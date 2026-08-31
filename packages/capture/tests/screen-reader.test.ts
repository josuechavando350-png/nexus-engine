import { describe, expect, it } from "vitest";
import {
  JawsScreenReaderAdapter,
  NvdaScreenReaderAdapter,
  VoiceOverScreenReaderAdapter,
  createSyntheticScreenReaderEvidence,
  screenReaderCanonicalJson,
  validateScreenReaderEvidence,
} from "../screen-reader.js";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const observedAt = "2026-08-31T06:10:00.000Z";

function fixtureEvents() {
  return Object.freeze([
    Object.freeze({ kind: "FOCUS" as const, at: observedAt, text: "Agendar consulta", role: "button" }),
    Object.freeze({ kind: "SPEECH" as const, at: "2026-08-31T06:10:00.100Z", text: "Agendar consulta, button" }),
  ]);
}

describe("screen reader evidence", () => {
  it("marks synthetic fixtures explicitly and never upgrades them to observed evidence", () => {
    const evidence = createSyntheticScreenReaderEvidence({
      scope,
      targetUrl: "https://example.com/#hero",
      reader: "NVDA",
      observedAt,
      readerVersion: "synthetic-fixture",
      events: fixtureEvents(),
    });
    expect(evidence.status).toBe("SYNTHETIC");
    expect(evidence.session).toEqual({ nativeSession: false, synthetic: true });
    expect(evidence.harness).toBeNull();
    expect(evidence.targetUrl).toBe("https://example.com/");
    expect(() => validateScreenReaderEvidence(evidence)).not.toThrow();
  });

  it("detects replay tampering", () => {
    const evidence = createSyntheticScreenReaderEvidence({
      scope,
      targetUrl: "https://example.com/",
      reader: "JAWS",
      observedAt,
      readerVersion: "synthetic-fixture",
      events: fixtureEvents(),
    });
    const tampered = { ...evidence, targetUrl: "https://example.org/" };
    expect(() => validateScreenReaderEvidence(tampered)).toThrow(/replay digest mismatch/);
  });

  it("rejects cyclic canonical inputs without unbounded recursion", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => screenReaderCanonicalJson(cyclic)).toThrow(/cyclic values/);
  });

  it("fails closed when a real NVDA harness is not usable on the current host", async () => {
    const evidence = await new NvdaScreenReaderAdapter().observe({ scope, targetUrl: "https://example.com/" });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.events).toEqual([]);
    expect(evidence.reason).toBeTruthy();
    expect(() => validateScreenReaderEvidence(evidence)).not.toThrow();
  });

  it("fails closed when a real JAWS harness is not usable on the current host", async () => {
    const evidence = await new JawsScreenReaderAdapter().observe({ scope, targetUrl: "https://example.com/" });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.events).toEqual([]);
    expect(evidence.reason).toBeTruthy();
    expect(() => validateScreenReaderEvidence(evidence)).not.toThrow();
  });

  it("fails closed when a real VoiceOver harness is not usable on the current host", async () => {
    const evidence = await new VoiceOverScreenReaderAdapter().observe({ scope, targetUrl: "https://example.com/" });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.events).toEqual([]);
    expect(evidence.reason).toBeTruthy();
    expect(() => validateScreenReaderEvidence(evidence)).not.toThrow();
  });

  it("honors cancellation before any external harness can run", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new NvdaScreenReaderAdapter({ executable: "/definitely/not/a/harness" });
    const evidence = await adapter.observe({ scope, targetUrl: "https://example.com/", signal: controller.signal });
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(() => validateScreenReaderEvidence(evidence)).not.toThrow();
  });

  it("rejects credential-bearing target URLs", async () => {
    await expect(new NvdaScreenReaderAdapter().observe({ scope, targetUrl: "https://user:pass@example.com/" })).rejects.toThrow(/credentials/);
  });
});
