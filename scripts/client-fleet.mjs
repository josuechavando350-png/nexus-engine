import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NON_CLIENT_PREFIXES = ["_", "reference-", "v2-probe-", "probe-", "test-"];

export function discoverClientApps(root = process.cwd()) {
  const appsRoot = join(root, "apps");
  if (!existsSync(appsRoot)) return [];
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !NON_CLIENT_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort((a, b) => a.localeCompare(b, "en"));
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadSceneManifest(appDir) {
  const path = join(appDir, "nexus-scenes.json");
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.scenes)) throw new Error(`invalid scene manifest: ${path}`);
  return manifest;
}

export function snapshotScenes(appDir, manifest) {
  return manifest.scenes.map((scene) => {
    if (!scene.id?.trim() || !Array.isArray(scene.paths) || scene.paths.length === 0) throw new Error("scene manifest entries require id and paths");
    const files = scene.paths.map((relativePath) => join(appDir, relativePath)).sort();
    for (const file of files) if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`scene source missing: ${file}`);
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file.slice(appDir.length));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
    return { sceneId: scene.id.trim(), digest: hash.digest("hex"), paths: [...scene.paths].sort() };
  }).sort((a, b) => a.sceneId.localeCompare(b.sceneId, "en"));
}

export function median(values) {
  if (!values.length) throw new Error("median requires values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function robustFleetAnomalies(samples, { minimumPeers = 5, zThreshold = 3.5 } = {}) {
  if (samples.length < minimumPeers) return { verdict: "INSUFFICIENT_EVIDENCE", minimumPeers, sampleCount: samples.length, anomalies: [] };
  const metrics = ["lcpP75Ms", "inpP75Ms", "clsP75"];
  const anomalies = [];
  for (const metric of metrics) {
    const values = samples.map((sample) => sample[metric]).filter(Number.isFinite);
    if (values.length < minimumPeers) continue;
    const center = median(values);
    const deviations = values.map((value) => Math.abs(value - center));
    const mad = median(deviations);
    if (mad === 0) continue;
    for (const sample of samples) {
      const value = sample[metric];
      if (!Number.isFinite(value)) continue;
      const robustZ = 0.6745 * (value - center) / mad;
      if (Math.abs(robustZ) >= zThreshold) anomalies.push({ projectId: sample.projectId, metric, value, fleetMedian: center, medianAbsoluteDeviation: mad, robustZ: Number(robustZ.toFixed(4)) });
    }
  }
  return { verdict: anomalies.length ? "ANOMALY_DETECTED" : "NO_ANOMALY_DETECTED", minimumPeers, sampleCount: samples.length, anomalies };
}
