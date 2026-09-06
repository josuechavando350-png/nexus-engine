import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./control/route";
import { POST } from "./score/route";

const SCORE_URL = "https://probe.example/api/cortex/friction/score";
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

function request(body: unknown, origin = "https://probe.example") {
  return new Request(SCORE_URL, {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CORTEX #9 pipeline-probe boundaries", () => {
  it("defaults control to KILLED and exposes active only from explicit runtime configuration", async () => {
    expect(await (await GET()).json()).toEqual({ mode: "KILLED" });
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "ACTIVE");
    expect(await (await GET()).json()).toEqual({ mode: "ACTIVE" });
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "INVALID");
    expect(await (await GET()).json()).toEqual({ mode: "KILLED" });
  });

  it("scores a valid same-origin real snapshot only in ACTIVE mode", async () => {
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "ACTIVE");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request(snapshot));
    expect(response.status).toBe(200);
    const body = await response.json() as { mode: string; score: { abandonmentProbability: number; riskBand: string } };
    expect(body.mode).toBe("ACTIVE");
    expect(body.score.abandonmentProbability).toBeGreaterThanOrEqual(0);
    expect(["LOW", "MEDIUM", "HIGH"]).toContain(body.score.riskBand);
    const emitted = String(log.mock.calls[0]?.[0]);
    expect(emitted).not.toContain("probe.example");
    expect(emitted).not.toContain("scrollDepthBps");
  });

  it("does not emit a score in OBSERVE_ONLY or KILLED modes", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "OBSERVE_ONLY");
    const observed = await POST(request(snapshot));
    expect(await observed.json()).toEqual({ mode: "OBSERVE_ONLY", score: null });

    vi.stubEnv("NEXUS_CORTEX_09_MODE", "KILLED");
    const killed = await POST(request(snapshot));
    expect(killed.status).toBe(503);
    expect(await killed.json()).toEqual({ mode: "KILLED" });
  });

  it("rejects cross-origin, unknown fields, and oversized streaming bodies", async () => {
    vi.stubEnv("NEXUS_CORTEX_09_MODE", "ACTIVE");
    expect((await POST(request(snapshot, "https://attacker.example"))).status).toBe(403);
    expect((await POST(request({ ...snapshot, email: "not-allowed@example.invalid" }))).status).toBe(400);
    expect((await POST(request({ ...snapshot, padding: "x".repeat(3_000) }))).status).toBe(400);
  });
});
