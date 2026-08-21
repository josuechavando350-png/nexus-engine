import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const NON_CLIENT_PREFIXES = ["_", "reference-", "v2-probe-", "probe-", "test-"];

function normalized(path) {
  return path.split(sep).join("/");
}

export function discoverClientApps(root = process.cwd()) {
  const appsRoot = join(root, "apps");
  if (!existsSync(appsRoot)) return [];
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !NON_CLIENT_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .filter((name) => {
      const manifestPath = join(appsRoot, name, "package.json");
      if (!existsSync(manifestPath)) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return manifest?.nexus?.clientProject === true;
    })
    .sort((a, b) => a.localeCompare(b, "en"));
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadSceneManifest(appDir) {
  const path = join(appDir, "nexus-scenes.json");
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error(`invalid scene manifest: ${path}`);
  }
  const ids = new Set();
  for (const scene of manifest.scenes) {
    if (typeof scene.id !== "string" || !scene.id.trim()) throw new Error(`scene id is required: ${path}`);
    if (ids.has(scene.id.trim())) throw new Error(`duplicate scene id ${scene.id}: ${path}`);
    ids.add(scene.id.trim());
    if (!Array.isArray(scene.artifactPaths) || scene.artifactPaths.length === 0 || scene.artifactPaths.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`scene ${scene.id} requires artifactPaths: ${path}`);
    }
  }
  return manifest;
}

export function snapshotScenes(appDir, manifest) {
  return manifest.scenes.map((scene) => {
    const files = [...scene.artifactPaths]
      .map((artifactPath) => join(appDir, artifactPath))
      .sort((a, b) => normalized(relative(appDir, a)).localeCompare(normalized(relative(appDir, b)), "en"));
    for (const file of files) {
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`scene build artifact missing: ${file}`);
    }
    const hash = createHash("sha256");
    const artifactPaths = [];
    for (const file of files) {
      const path = normalized(relative(appDir, file));
      const bytes = readFileSync(file);
      artifactPaths.push(path);
      hash.update(path);
      hash.update("\0");
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
    return Object.freeze({ sceneId: scene.id.trim(), digest: hash.digest("hex"), artifactPaths: Object.freeze(artifactPaths) });
  }).sort((a, b) => a.sceneId.localeCompare(b.sceneId, "en"));
}
