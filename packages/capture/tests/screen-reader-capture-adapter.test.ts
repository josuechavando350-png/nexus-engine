import { describe, expect, it } from "vitest";
import type { CaptureRequest } from "../index.js";
import { ScreenReaderCaptureAdapter } from "../screen-reader-capture-adapter.js";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const run = Object.freeze({
  runId: "run_screen_reader_fixture",
  workloadId: "workload-screen-reader",
  workloadVersion: "1",
  workloadDigest: "wrk_fixture",
  environmentDigest: "env_fixture",
  scope,
  startedAt: "2026-08-31T06:10:00.000Z",
});

function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return Object.freeze({
    run,
    scope,
    targetId: "https://example.com/",
    capabilities: Object.freeze(["SCREEN_READER"] as const),
    metadata: Object.freeze({ screenReader: "NVDA" }),
    ...overrides,
  });
}

describe("ScreenReaderCaptureAdapter", () => {
  it("returns UNSUPPORTED instead of fabricating evidence when native infrastructure is absent", async () => {
    const adapter = new ScreenReaderCaptureAdapter({ outputDir: "/tmp/nexus-screen-reader-test" });
    const result = await adapter.capture(request());
    expect(result.outcome).toBe("UNSUPPORTED");
    expect(result.artifacts).toEqual([]);
    expect(result.reason).toBeTruthy();
  });

  it("fails closed when reader selection metadata is missing", async () => {
    const adapter = new ScreenReaderCaptureAdapter({ outputDir: "/tmp/nexus-screen-reader-test" });
    const result = await adapter.capture(request({ metadata: undefined }));
    expect(result.outcome).toBe("FAILED");
    expect(result.reason).toMatch(/metadata\.screenReader/);
    expect(result.artifacts).toEqual([]);
  });

  it("does not claim unrelated capture capabilities", async () => {
    const adapter = new ScreenReaderCaptureAdapter({ outputDir: "/tmp/nexus-screen-reader-test" });
    const result = await adapter.capture(request({ capabilities: Object.freeze(["SCREENSHOT"] as const) }));
    expect(result.outcome).toBe("UNSUPPORTED");
    expect(result.artifacts).toEqual([]);
  });
});
