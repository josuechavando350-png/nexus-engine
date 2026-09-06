import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./control/route";
import { POST } from "./observe/route";

const OBSERVE_URL = "https://probe.example/api/cortex/prerender/observe";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CORTEX #8 pipeline-probe production boundaries", () => {
  it("fails closed when runtime control is absent or invalid and exposes only real probe paths", async () => {
    const defaultResponse = await GET();
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toEqual({
      mode: "KILLED",
      allowedPaths: ["/", "/explore", "/proof", "/visit", "/contact"],
      maxPreparedTargets: 4,
    });

    vi.stubEnv("NEXUS_CORTEX_08_MODE", "ACTIVE");
    vi.stubEnv("NEXUS_CORTEX_08_MAX_PREPARED_TARGETS", "2");
    const active = await GET();
    expect(await active.json()).toMatchObject({ mode: "ACTIVE", maxPreparedTargets: 2 });
    expect(active.headers.get("cache-control")).toContain("no-store");

    vi.stubEnv("NEXUS_CORTEX_08_MAX_PREPARED_TARGETS", "100");
    expect(await (await GET()).json()).toMatchObject({ mode: "KILLED", maxPreparedTargets: 1 });
  });

  it("accepts only bounded same-origin minimized telemetry without targets, payloads, or identities", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(new Request(OBSERVE_URL, {
      method: "POST",
      headers: {
        origin: "https://probe.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ signal: "pointerenter", action: "PRERENDER", reason: "SELECTED" }),
    }));
    expect(response.status).toBe(204);
    expect(log).toHaveBeenCalledTimes(1);
    const emitted = String(log.mock.calls[0]?.[0]);
    expect(emitted).toContain("cortex-08-interaction-pointer-prerenderer");
    expect(emitted).not.toContain("probe.example");

    const withTarget = await POST(new Request(OBSERVE_URL, {
      method: "POST",
      headers: { origin: "https://probe.example", "content-type": "application/json" },
      body: JSON.stringify({ signal: "pointerenter", action: "PRERENDER", reason: "SELECTED", target: "/proof" }),
    }));
    expect(withTarget.status).toBe(400);
  });

  it("rejects cross-origin telemetry and enforces the body limit while streaming", async () => {
    const crossOrigin = await POST(new Request(OBSERVE_URL, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    }));
    expect(crossOrigin.status).toBe(403);

    const oversized = await POST(new Request(OBSERVE_URL, {
      method: "POST",
      headers: { origin: "https://probe.example", "content-type": "application/json" },
      body: JSON.stringify({ signal: "pointerenter", action: "NONE", reason: "CONTROL_UNAVAILABLE", padding: "x".repeat(600) }),
    }));
    expect(oversized.status).toBe(400);
  });

  it("uses an exact JSON contract for telemetry enums", async () => {
    const invalid = await POST(new Request(OBSERVE_URL, {
      method: "POST",
      headers: { origin: "https://probe.example", "content-type": "application/json" },
      body: JSON.stringify({ signal: "click", action: "PRERENDER", reason: "SELECTED" }),
    }));
    expect(invalid.status).toBe(400);
  });
});
