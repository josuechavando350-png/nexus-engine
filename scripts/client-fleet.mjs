import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const NON_CLIENT_PREFIXES = ["_", "reference-", "v2-probe-", "probe-", "test-"];
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function normalized(path) {
  return path.split(sep).join("/");
}

function confinedPath(appDir, artifactPath) {
  if (typeof artifactPath !== "string" || !artifactPath.trim()) throw new Error("scene artifact path must be a non-empty string");
  const root = resolve(appDir);
  const absolute = resolve(root, artifactPath);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new Error(`scene artifact escapes client app: ${artifactPath}`);
  return absolute;
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
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenes) || manifest.scenes.length === 0) throw new Error(`invalid scene manifest: ${path}`);
  const ids = new Set();
  for (const scene of manifest.scenes) {
    if (typeof scene.id !== "string" || !scene.id.trim()) throw new Error(`scene id is required: ${path}`);
    const id = scene.id.trim();
    if (ids.has(id)) throw new Error(`duplicate scene id ${scene.id}: ${path}`);
    ids.add(id);
    if (!Array.isArray(scene.artifactPaths) || scene.artifactPaths.length === 0) throw new Error(`scene ${scene.id} requires artifactPaths: ${path}`);
    const normalizedPaths = scene.artifactPaths.map((artifactPath) => normalized(relative(resolve(appDir), confinedPath(appDir, artifactPath))));
    if (new Set(normalizedPaths).size !== normalizedPaths.length) throw new Error(`scene ${scene.id} contains duplicate artifact paths: ${path}`);
  }
  return manifest;
}

export function snapshotScenes(appDir, manifest) {
  return manifest.scenes.map((scene) => {
    const files = scene.artifactPaths
      .map((artifactPath) => confinedPath(appDir, artifactPath))
      .sort((a, b) => normalized(relative(appDir, a)).localeCompare(normalized(relative(appDir, b)), "en"));
    for (const file of files) if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`scene build artifact missing: ${file}`);
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

export function loadShadowBaseline(appDir, projectId) {
  const path = join(appDir, "nexus-shadow-baseline.json");
  if (!existsSync(path)) return null;
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  if (baseline?.schemaVersion !== 1 || baseline.authority !== "NEXUS_SHADOW_BASELINE_V1" || baseline.projectId !== projectId || !SHA1.test(baseline.sourceRevision) || typeof baseline.engineVersion !== "string" || !baseline.engineVersion.trim() || !Array.isArray(baseline.scenes) || baseline.scenes.length === 0) {
    throw new Error(`invalid shadow baseline: ${path}`);
  }
  const ids = new Set();
  for (const scene of baseline.scenes) {
    if (typeof scene.sceneId !== "string" || !scene.sceneId.trim() || ids.has(scene.sceneId.trim())) throw new Error(`invalid or duplicate baseline scene id: ${path}`);
    ids.add(scene.sceneId.trim());
    if (!SHA256.test(scene.digest) || !Array.isArray(scene.artifactPaths) || scene.artifactPaths.length === 0) throw new Error(`invalid baseline scene evidence: ${path}`);
    const paths = scene.artifactPaths.map((artifactPath) => normalized(relative(resolve(appDir), confinedPath(appDir, artifactPath))));
    if (new Set(paths).size !== paths.length) throw new Error(`duplicate baseline artifact paths: ${path}`);
  }
  return baseline;
}
