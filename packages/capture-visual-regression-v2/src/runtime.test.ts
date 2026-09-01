import { describe, expect, it, vi } from "vitest";
import { createScene, createViewport, type CaptureArtifact } from "./index.js";
import { captureSceneAtNavigationUrl } from "./runtime.js";

const BUILD_DIGEST = "b".repeat(64);

function captured(sceneDigest: string): CaptureArtifact {
  return {
    path: "/tmp/current.png",
    record: {
      sceneDigest,
      revision: "a".repeat(40),
      buildDigest: BUILD_DIGEST,
      environment: {
        browserName: "chromium",
        browserVersion: "fixture",
        playwrightVersion: "fixture",
        platform: "linux",
        arch: "x64",
        timezoneId: "UTC",
        locale: "en-US",
        reducedMotion: "reduce",
        colorScheme: "light",
        deviceScaleFactor: 1,
        screenshotScale: "css",
        animations: "disabled",
        caret: "hide",
        digest: "e".repeat(64),
      },
      viewport: createViewport("desktop", 1440, 1000),
      width: 1440,
      height: 1000,
      screenshotSha256: "c".repeat(64),
      masks: [],
      digest: "d".repeat(64),
    },
  };
}

describe("visual regression runtime navigation boundary", () => {
  it("navigates through an ephemeral URL while preserving the sealed logical scene", async () => {
    const scene = createScene({ id: "cano-home", url: "https://nexus.local/cano-penal/" });
    const executor = vi.fn(async (input: { scene: typeof scene; navigationUrl?: string }) => captured(input.scene.digest));
    const result = await captureSceneAtNavigationUrl({
      scene,
      navigationUrl: "http://127.0.0.1:43871/#transport-only",
      browserName: "chromium",
      viewport: createViewport("desktop", 1440, 1000),
      revision: "a".repeat(40),
      buildDigest: BUILD_DIGEST,
      outDir: "/tmp",
    }, executor as never);

    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]?.[0].scene).toBe(scene);
    expect(executor.mock.calls[0]?.[0].scene.url).toBe("https://nexus.local/cano-penal/");
    expect(executor.mock.calls[0]?.[0].scene.digest).toBe(scene.digest);
    expect(executor.mock.calls[0]?.[0].navigationUrl).toBe("http://127.0.0.1:43871/");
    expect(result.record.sceneDigest).toBe(scene.digest);
  });

  it("rejects non-HTTP transport URLs before invoking capture", async () => {
    const scene = createScene({ id: "home", url: "https://nexus.local/client/" });
    const executor = vi.fn();
    await expect(captureSceneAtNavigationUrl({
      scene,
      navigationUrl: "file:///tmp/page.html",
      browserName: "chromium",
      viewport: createViewport("desktop", 1440, 1000),
      revision: "a".repeat(40),
      buildDigest: BUILD_DIGEST,
      outDir: "/tmp",
    }, executor as never)).rejects.toThrow(/must use HTTP/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed if an executor returns evidence bound to another scene", async () => {
    const scene = createScene({ id: "home", url: "https://nexus.local/client/" });
    const executor = vi.fn(async () => captured("f".repeat(64)));
    await expect(captureSceneAtNavigationUrl({
      scene,
      navigationUrl: "http://127.0.0.1:31000/",
      browserName: "chromium",
      viewport: createViewport("desktop", 1440, 1000),
      revision: "a".repeat(40),
      buildDigest: BUILD_DIGEST,
      outDir: "/tmp",
    }, executor as never)).rejects.toThrow(/changed the stable scene identity digest/);
  });
});
