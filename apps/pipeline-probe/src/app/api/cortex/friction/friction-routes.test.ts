import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./control/route";
import { POST } from "./score/route";

const SCORE_URL = "https://probe.example/api/cortex/friction/score";
const MODEL_DIGEST = `sha256:${"a".repeat(64)}`;
const model = {
  schemaVersion: 1,
  modelId: "test-calibration-v1",
  sourceDigest: MODEL_DIGEST,
  intercept: -3,
  coefficients: {
    interactionLatency: 2,
    validationErrorRatio: 2,
    repeatedActionRatio: 2,
    longTaskRate: 2,
    visibilityLossRate: 2,
    scrollDeficit: 2,
    mobileIndicator: 0,
  },
  lowRiskMax: 0.33,
  mediumRiskMax: 0.66,
};
const snapshot = {
  schemaVersion: 1,
  deviceClass: "DESKTOP",
  elapsedMs: 30_000,
  scrollDepthBps: 5_000,
  maxInteractionLatencyMs: 250,
  interactionCount: 5,
  validationErrorCount: 1,
  repeatedActionCount: 1,
  longTaskCount: 1,
  visibilityLossCount: 0,
};

function enable(mode: "ACTIVE" | "OBSERVE_ONLY") {
  vi.stubEnv("NEXUS_CORTEX_09_MODE", mode);
  vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", JSON.stringify(model));
}

function request(body: unknown, origin = "https://probe.example", contentType = "application/json") {
  return new Request(SCORE_URL, {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin", "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CORTEX #9 pipeline-probe boundaries", () => {
  it("defaults to KILLED and refuses ACTIVE without a valid model artifact", async () => {
    expect(await (await GET()).json()).toEqual({ mode: "KILLED", modelId: null, modelSourceDigest: null });
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "ACTIVE");
    expect(await (await GET()).json()).toEqual({ mode: "KILLED", modelId: null, modelSourceDigest: null });
    vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", "not-json");
    expect(await (await GET()).json()).toEqual({ mode: "KILLED", modelId: null, modelSourceDigest: null });
    vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", JSON.stringify(model));
    expect(await (await GET()).json()).toEqual({ mode: "ACTIVE", modelId: model.modelId, modelSourceDigest: MODEL_DIGEST });
  });

  it("scores a valid same-origin snapshot only under one configured model revision", async () => {
    enable("ACTIVE");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request(snapshot));
    expect(response.status).toBe(200);
    const body = await response.json() as { mode: string; score: { abandonmentProbability: number; riskBand: string; modelSourceDigest: string } };
    expect(body.mode).toBe("ACTIVE");
    expect(body.score.abandonmentProbability).toBeGreaterThanOrEqual(0);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(body.score.riskBand);
    expect(body.score.modelSourceDigest).toBe(MODEL_DIGEST);
    const emitted = String(log.mock.calls[0]?.[0]);
    expect(emitted).toContain(MODEL_DIGEST);
    expect(emitted).not.toContain("probe.example");
    expect(emitted).not.toContain("scrollDepthBps");
  });

  it("does not emit a score in OBSERVE_ONLY or KILLED modes", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    enable("OBSERVE_ONLY");
    const observed = await POST(request(snapshot));
    expect(await observed.json()).toEqual({ mode: "OBSERVE_ONLY", score: null });

    vi.stubEnv("NEXUS_CORTEX_09_MODE", "KILLED");
    const killed = await POST(request(snapshot));
    expect(killed.status).toBe(503);
    expect(await killed.json()).toEqual({ mode: "KILLED" });
  });

  it("rejects cross-origin, malformed media, unknown fields, and oversized streaming bodies", async () => {
    enable("ACTIVE");
    expect((await POST(request(snapshot, "https://attacker.example"))).status).toBe(403);
    expect((await POST(request(snapshot, "https://probe.example", "text/plain"))).status).toBe(400);
    expect((await POST(request("{broken-json"))).status).toBe(400);
    expect((await POST(request({ ...snapshot, email: "not-allowed@example.invalid" }))).status).toBe(400);
    expect((await POST(request({ ...snapshot, padding: "x".repeat(3_000) }))).status).toBe(400);
  });
});
