import { describe, expect, it } from "vitest";
import { createScene, createViewport } from "./index.js";
import { captureSceneAtNavigationUrl } from "./runtime-navigation.js";

const scene = createScene({ id: "stable-home", url: "https://nexus.invalid/projects/example/" });
const viewport = createViewport("desktop", 1280, 720);

const base = {
  scene,
  browserName: "chromium" as const,
  viewport,
  revision: "a".repeat(40),
  buildDigest: "b".repeat(64),
  outDir: "/tmp/nexus-runtime-navigation-test",
};

describe("runtime navigation capture contract", () => {
  it("rejects non-HTTP runtime navigation before launching a browser", async () => {
    await expect(captureSceneAtNavigationUrl({ ...base, navigationUrl: "file:///etc/passwd" })).rejects.toThrow(/HTTP\(S\)/);
  });

  it("rejects malformed build provenance before launching a browser", async () => {
    await expect(captureSceneAtNavigationUrl({ ...base, navigationUrl: "http://127.0.0.1:3000/", buildDigest: "not-a-digest" })).rejects.toThrow(/buildDigest/);
  });

  it("rejects credential-bearing runtime navigation before launching a browser", async () => {
    await expect(captureSceneAtNavigationUrl({ ...base, navigationUrl: "https://user:secret@example.com/" })).rejects.toThrow(/credentials/);
  });
});
