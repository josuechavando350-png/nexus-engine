import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverClientApps, loadSceneManifest, loadShadowBaseline, snapshotScenes } from "./client-fleet.mjs";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "nexus-fleet-"));
  roots.push(root);
  return root;
}

function writePackage(root, name, clientProject) {
  const dir = join(root, "apps", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, nexus: { clientProject } }, null, 2)}\n`);
  return dir;
}

describe("client fleet", () => {
  it("counts only explicitly declared real clients and never seeds/references/probes", () => {
    const root = tempRoot();
    writePackage(root, "_experience-seed", true);
    writePackage(root, "reference-alfil", true);
    writePackage(root, "v2-probe-editorial", true);
    writePackage(root, "unmarked-app", false);
    writePackage(root, "cano-legal", true);
    writePackage(root, "zona-dental", true);
    expect(discoverClientApps(root)).toEqual(["cano-legal", "zona-dental"]);
  });

  it("hashes declared build artifacts per scene in stable path order", () => {
    const root = tempRoot();
    const appDir = writePackage(root, "client-one", true);
    mkdirSync(join(appDir, "out"), { recursive: true });
    writeFileSync(join(appDir, "out", "b.html"), "B");
    writeFileSync(join(appDir, "out", "a.html"), "A");
    writeFileSync(join(appDir, "nexus-scenes.json"), `${JSON.stringify({ schemaVersion: 1, scenes: [{ id: "hero", artifactPaths: ["out/b.html", "out/a.html"] }] }, null, 2)}\n`);
    const first = snapshotScenes(appDir, loadSceneManifest(appDir));
    writeFileSync(join(appDir, "nexus-scenes.json"), `${JSON.stringify({ schemaVersion: 1, scenes: [{ id: "hero", artifactPaths: ["out/a.html", "out/b.html"] }] }, null, 2)}\n`);
    const second = snapshotScenes(appDir, loadSceneManifest(appDir));
    expect(first).toEqual(second);
    expect(first[0].artifactPaths).toEqual(["out/a.html", "out/b.html"]);
  });

  it("fails closed when a declared scene artifact is missing or escapes the client app", () => {
    const root = tempRoot();
    const appDir = writePackage(root, "client-one", true);
    writeFileSync(join(root, "outside.html"), "outside");
    writeFileSync(join(appDir, "nexus-scenes.json"), `${JSON.stringify({ schemaVersion: 1, scenes: [{ id: "hero", artifactPaths: ["out/missing.html"] }] }, null, 2)}\n`);
    expect(() => snapshotScenes(appDir, loadSceneManifest(appDir))).toThrow(/artifact missing/);
    writeFileSync(join(appDir, "nexus-scenes.json"), `${JSON.stringify({ schemaVersion: 1, scenes: [{ id: "hero", artifactPaths: ["../../outside.html"] }] }, null, 2)}\n`);
    expect(() => loadSceneManifest(appDir)).toThrow(/escapes client app/);
  });

  it("accepts only a project-bound cryptographic shadow baseline", () => {
    const root = tempRoot();
    const appDir = writePackage(root, "client-one", true);
    mkdirSync(join(appDir, "out"), { recursive: true });
    writeFileSync(join(appDir, "out", "hero.html"), "hero");
    writeFileSync(join(appDir, "nexus-scenes.json"), `${JSON.stringify({ schemaVersion: 1, scenes: [{ id: "hero", artifactPaths: ["out/hero.html"] }] }, null, 2)}\n`);
    const scenes = snapshotScenes(appDir, loadSceneManifest(appDir));
    writeFileSync(join(appDir, "nexus-shadow-baseline.json"), `${JSON.stringify({ schemaVersion: 1, authority: "NEXUS_SHADOW_BASELINE_V1", projectId: "client-one", sourceRevision: "a".repeat(40), engineVersion: "6.0.0", scenes }, null, 2)}\n`);
    expect(loadShadowBaseline(appDir, "client-one")?.scenes).toEqual(scenes);
    expect(() => loadShadowBaseline(appDir, "other-client")).toThrow(/invalid shadow baseline/);
  });
});
