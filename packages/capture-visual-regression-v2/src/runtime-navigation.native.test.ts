import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScene, createViewport, validateCaptureRecord } from "./index.js";
import { captureSceneAtNavigationUrl } from "./runtime-navigation.js";

const nativeProof = process.env.NEXUS_NATIVE_VISUAL_PROOF === "1" ? describe : describe.skip;
const servers: Server[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureUrl(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><style>body{margin:0;font-family:Arial,sans-serif}main{padding:48px}h1{font-size:48px}</style></head><body><main><h1>NEXUS stable scene</h1><p>runtime port must not become scene identity</p></main></body></html>");
  });
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}/`;
}

nativeProof("stable scene identity with real browser navigation", () => {
  it("keeps scene provenance stable while recording each actual runtime URL", async () => {
    const scene = createScene({ id: "project-home", url: "https://nexus.invalid/project/example/home" });
    const viewport = createViewport("desktop", 1024, 768);
    const outDir = await mkdtemp(join(tmpdir(), "nexus-runtime-navigation-"));
    temporaryRoots.push(outDir);
    const firstUrl = await fixtureUrl();
    const secondUrl = await fixtureUrl();

    const first = await captureSceneAtNavigationUrl({ scene, navigationUrl: firstUrl, browserName: "chromium", viewport, revision: "a".repeat(40), buildDigest: "b".repeat(64), outDir: join(outDir, "first") });
    const second = await captureSceneAtNavigationUrl({ scene, navigationUrl: secondUrl, browserName: "chromium", viewport, revision: "c".repeat(40), buildDigest: "d".repeat(64), outDir: join(outDir, "second") });

    validateCaptureRecord(first.record);
    validateCaptureRecord(second.record);
    expect(first.navigationUrl).toBe(firstUrl);
    expect(second.navigationUrl).toBe(secondUrl);
    expect(first.navigationUrl).not.toBe(second.navigationUrl);
    expect(first.record.sceneDigest).toBe(scene.digest);
    expect(second.record.sceneDigest).toBe(scene.digest);
    expect(first.record.screenshotSha256).toBe(second.record.screenshotSha256);
    expect(first.record.digest).not.toBe(second.record.digest);
  });
});
