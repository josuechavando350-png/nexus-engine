import { describe, expect, it } from "vitest";
import {
  computeRiskNetworkKeyHash,
  evaluateSignedRiskEnvelopeForNetwork,
} from "../../fraud-risk-gate/index.js";
import {
  BoundedMemoryClickReplayStore,
  CidrNetworkClassifier,
  InvalidTrafficClickScorer,
} from "./risk-scoring.js";

const SIGNING_SECRET = "signing-secret-000000000000000000000001";
const NETWORK_SECRET = "network-secret-000000000000000000000001";
const REPLAY_SECRET = "replay-secret-0000000000000000000000001";
const NOW = Date.parse("2026-09-08T05:00:00.000Z");

function scorer(overrides: Partial<ConstructorParameters<typeof InvalidTrafficClickScorer>[0]> = {}) {
  return new InvalidTrafficClickScorer({
    signingSecret: SIGNING_SECRET,
    networkSecret: NETWORK_SECRET,
    clickReplaySecret: REPLAY_SECRET,
    providerId: "nexus-invalid-traffic-v1",
    networkClassifier: new CidrNetworkClassifier([
      { id: "residential-v4", cidr: "203.0.113.0/24", networkClass: "RESIDENTIAL" },
      { id: "datacenter-v4", cidr: "198.51.100.0/24", networkClass: "DATACENTER" },
      { id: "tor-v6", cidr: "2001:db8:dead::/48", networkClass: "TOR" },
      { id: "business-v6", cidr: "2001:db8:1234::/48", networkClass: "BUSINESS" },
    ]),
    replayStore: new BoundedMemoryClickReplayStore(100),
    now: () => NOW,
    idFactory: () => "assessment-0001",
    ...overrides,
  });
}

const browserHeaders = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
} as const;

describe("CidrNetworkClassifier", () => {
  it("uses longest-prefix matching for IPv4 and classifies IPv6", () => {
    const classifier = new CidrNetworkClassifier([
      { id: "broad", cidr: "203.0.113.0/24", networkClass: "BUSINESS" },
      { id: "specific", cidr: "203.0.113.128/25", networkClass: "DATACENTER" },
      { id: "ipv6", cidr: "2001:db8:abcd::/48", networkClass: "VPN" },
    ]);

    expect(classifier.classify("203.0.113.20")).toEqual({ networkClass: "BUSINESS", matchedRuleId: "broad" });
    expect(classifier.classify("203.0.113.200")).toEqual({ networkClass: "DATACENTER", matchedRuleId: "specific" });
    expect(classifier.classify("2001:db8:abcd::42")).toEqual({ networkClass: "VPN", matchedRuleId: "ipv6" });
    expect(classifier.classify("192.0.2.9")).toEqual({ networkClass: "UNKNOWN", matchedRuleId: null });
  });

  it("rejects malformed CIDR input instead of guessing", () => {
    expect(() => new CidrNetworkClassifier([{ id: "bad-rule", cidr: "203.0.113.999/24", networkClass: "DATACENTER" }])).toThrow(/clientIp|CIDR/u);
  });
});

describe("InvalidTrafficClickScorer", () => {
  it("keeps a normal residential navigation low-risk and emits a network-bound signed envelope", async () => {
    const result = await scorer().assess({
      url: "https://example.test/?gclid=EAIaIQobChMI-valid-click-123456789",
      clientIp: "203.0.113.20",
      headers: browserHeaders,
    });

    expect(result.riskScore).toBe(0);
    expect(result.networkClass).toBe("RESIDENTIAL");
    expect(result.googleClickIdKind).toBe("gclid");
    expect(result.signals).toEqual([]);

    const expectedHash = computeRiskNetworkKeyHash("203.0.113.20", NETWORK_SECRET);
    expect(evaluateSignedRiskEnvelopeForNetwork(
      result.envelope,
      SIGNING_SECRET,
      { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 60, maxFutureSkewSeconds: 5 },
      expectedHash,
      NOW,
    )).toMatchObject({ action: "ALLOW", riskScore: 0 });
  });

  it("scores automation on a datacenter network and replay without persisting the raw click id", async () => {
    const replayStore = new BoundedMemoryClickReplayStore(100);
    const detector = scorer({ replayStore });
    const rawClickId = "EAIaIQobChMI-replayed-secret-click-999999";
    const input = {
      url: `https://example.test/?gclid=${rawClickId}`,
      clientIp: "198.51.100.42",
      headers: {
        "user-agent": "Mozilla/5.0 HeadlessChrome/140.0",
        accept: "application/json",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
      },
    } as const;

    const first = await detector.assess(input);
    const second = await detector.assess(input);

    expect(first.riskScore).toBe(1_000);
    expect(first.signals.map((signal) => signal.code)).toEqual(expect.arrayContaining([
      "NETWORK_DATACENTER",
      "AUTOMATION_USER_AGENT",
      "NON_DOCUMENT_FETCH_DEST",
      "NON_NAVIGATION_FETCH_MODE",
      "HTML_NOT_ACCEPTED",
    ]));
    expect(second.signals.map((signal) => signal.code)).toContain("REPLAYED_GOOGLE_CLICK_ID");
    expect(JSON.stringify(first)).not.toContain(rawClickId);
    expect(JSON.stringify(first)).not.toContain("198.51.100.42");
  });

  it("treats multiple Google click IDs as suspicious instead of selecting one", async () => {
    const result = await scorer().assess({
      url: "https://example.test/?gclid=EAIaIQobChMI-valid-click-111111&gbraid=EAIaIQobChMI-valid-click-222222",
      clientIp: "203.0.113.30",
      headers: browserHeaders,
    });

    expect(result.hasGoogleClickId).toBe(false);
    expect(result.googleClickIdKind).toBeNull();
    expect(result.signals.map((signal) => signal.code)).toContain("MULTIPLE_GOOGLE_CLICK_IDS");
    expect(result.riskScore).toBeGreaterThanOrEqual(650);
  });

  it("expires process-local replay entries after their TTL", async () => {
    let now = NOW;
    const detector = scorer({
      now: () => now,
      replayTtlMs: 1_000,
      idFactory: () => "assessment-ttl01",
    });
    const input = {
      url: "https://example.test/?wbraid=EAIaIQobChMI-valid-click-ttl-123456",
      clientIp: "203.0.113.50",
      headers: browserHeaders,
    } as const;

    expect((await detector.assess(input)).signals.map((signal) => signal.code)).not.toContain("REPLAYED_GOOGLE_CLICK_ID");
    now += 500;
    expect((await detector.assess(input)).signals.map((signal) => signal.code)).toContain("REPLAYED_GOOGLE_CLICK_ID");
    now += 1_001;
    expect((await detector.assess(input)).signals.map((signal) => signal.code)).not.toContain("REPLAYED_GOOGLE_CLICK_ID");
  });

  it("can score IPv6 TOR ranges to a deny-grade envelope", async () => {
    const result = await scorer().assess({
      url: "https://example.test/",
      clientIp: "2001:db8:dead::99",
      headers: browserHeaders,
    });
    expect(result.networkClass).toBe("TOR");
    expect(result.riskScore).toBe(850);
    const expectedHash = computeRiskNetworkKeyHash("2001:db8:dead::99", NETWORK_SECRET);
    expect(evaluateSignedRiskEnvelopeForNetwork(
      result.envelope,
      SIGNING_SECRET,
      { challengeAtOrAbove: 500, denyAtOrAbove: 800, maxAssessmentAgeSeconds: 60, maxFutureSkewSeconds: 5 },
      expectedHash,
      NOW,
    ).action).toBe("DENY");
  });
});
