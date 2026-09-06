import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FRICTION_FEATURE_CONTRACT_ID } from "@nexus/core/cortex/friction-abandonment-scoring";
import { GET } from "./control/route";
import { POST } from "./score/route";

const SCORE_URL = "https://probe.example/api/cortex/friction/score";
const MODEL_SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const model = {
  schemaVersion: 1,
  featureContractId: FRICTION_FEATURE_CONTRACT_ID,
  modelId: "ci-fixture-do-not-use",
  sourceDigest: MODEL_SOURCE_DIGEST,
  intercept: -3,
  coefficients: {
    interactionLatency: 2,
    validationErrorRatio: 2,
    repeatedActionRatio: 2,
    longTaskRate: 2,
    visibilityLossRate: 2,
    scrollDeficit: 2,
    coarsePointerIndicator: 0,
  },
  lowRiskMax: 0.33,
  mediumRiskMax: 0.66,
};
const MODEL_JSON = JSON.stringify(model);
const MODEL_ARTIFACT_DIGEST = `sha256:${createHash("sha256").update(MODEL_JSON, "utf8").digest("hex")}`;
const snapshot = {
  schemaVersion: 1,
  featureContractId: FRICTION_FEATURE_CONTRACT_ID,
  pointerClass: "FINE",
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
  vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", MODEL_JSON);
  vi.stubEnv("NEXUS_CORTEX_09_MODEL_ARTIFACT_DIGEST", MODEL_ARTIFACT_DIGEST);
  vi.stubEnv("NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST", MODEL_SOURCE_DIGEST);
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
  it("defaults to KILLED and requires exact model integrity plus independent calibration provenance", async () => {
    expect(await (await GET()).json()).toEqual({
      mode: "KILLED",
      featureContractId: FRICTION_FEATURE_CONTRACT_ID,
      modelId: null,
      modelSourceDigest: null,
      modelArtifactDigest: null,
    });

    vi.stubEnv("NEXUS_CORTEX_09_MODE", "ACTIVE");
    vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", MODEL_JSON);
    expect((await (await GET()).json()).mode).toBe("KILLED");

    vi.stubEnv("NEXUS_CORTEX_09_MODEL_ARTIFACT_DIGEST", `sha256:${"b".repeat(64)}`);
    vi.stubEnv("NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST", MODEL_SOURCE_DIGEST);
    expect((await (await GET()).json()).mode).toBe("KILLED");

    vi.stubEnv("NEXUS_CORTEX_09_MODEL_ARTIFACT_DIGEST", MODEL_ARTIFACT_DIGEST);
    vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", `${MODEL_JSON}\n`);
    expect((await (await GET()).json()).mode).toBe("KILLED");

    vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", " ".repeat(65_537));
    expect((await (await GET()).json()).mode).toBe("KILLED");

    vi.stubEnv("NEXUS_CORTEX_09_MODEL_JSON", MODEL_JSON);
    vi.stubEnv("NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST", `sha256:${"c".repeat(64)}`);
    expect((await (await GET()).json()).mode).toBe("KILLED");

    vi.stubEnv("NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST", MODEL_SOURCE_DIGEST);
    expect(await (await GET()).json()).toEqual({
      mode: "ACTIVE",
      featureContractId: FRICTION_FEATURE_CONTRACT_ID,
      modelId: model.modelId,
      modelSourceDigest: MODEL_SOURCE_DIGEST,
      modelArtifactDigest: MODEL_ARTIFACT_DIGEST,
    });
  });

  it("scores a valid same-origin snapshot under the exact configured artifact", async () => {
    enable("ACTIVE");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request(snapshot));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      mode: string;
      modelArtifactDigest: string;
      score: { abandonmentProbability: number; riskBand: string; modelSourceDigest: string; pointerClass: string };
    };
    expect(body.mode).toBe("ACTIVE");
    expect(body.modelArtifactDigest).toBe(MODEL_ARTIFACT_DIGEST);
    expect(body.score.modelSourceDigest).toBe(MODEL_SOURCE_DIGEST);
    expect(body.score.pointerClass).toBe("FINE");
    expect(body.score.abandonmentProbability).toBeGreaterThanOrEqual(0);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(body.score.riskBand);
    const emitted = String(log.mock.calls[0]?.[0]);
    expect(emitted).toContain(MODEL_ARTIFACT_DIGEST);
    expect(emitted).toContain(MODEL_SOURCE_DIGEST);
    expect(emitted).not.toContain("probe.example");
    expect(emitted).not.toContain("scrollDepthBps");
    expect(emitted).not.toContain("validationErrorCount");
  });

  it("executes the scoring boundary in OBSERVE_ONLY without returning an actionable score", async () => {
    enable("OBSERVE_ONLY");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request(snapshot));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "OBSERVE_ONLY",
      modelArtifactDigest: MODEL_ARTIFACT_DIGEST,
      score: null,
    });
    const emitted = String(log.mock.calls[0]?.[0]);
    expect(emitted).toContain("OBSERVE_ONLY");
    expect(emitted).toContain("riskBand");
    expect(emitted).toContain(MODEL_ARTIFACT_DIGEST);
  });

  it("refuses scoring in KILLED mode", async () => {
    enable("ACTIVE");
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "KILLED");
    const response = await POST(request(snapshot));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ mode: "KILLED" });
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
