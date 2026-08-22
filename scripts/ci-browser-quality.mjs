import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.env.NEXUS_CAPTURE_EVIDENCE_DIR || "artifacts/browser-capture";
const baselineRoot = process.env.NEXUS_VISUAL_BASELINE_DIR || "quality-baselines/browser-capture";
const decodedBaselineRoot = ".artifacts/visual-baselines";
const maxChangedRatio = Number(process.env.NEXUS_VISUAL_MAX_CHANGED_RATIO || "0.001");
const sourceRevision = process.env.NEXUS_VALIDATED_SHA || process.env.GITHUB_SHA || "UNKNOWN";
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

if (!existsSync(root)) throw new Error(`capture evidence directory does not exist: ${root}`);
if (!Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1) {
  throw new Error("NEXUS_VISUAL_MAX_CHANGED_RATIO must be in [0,1]");
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const normalizePath = (path) => path.split(sep).join("/");

const resolveBaseline = (name) => {
  const binary = join(baselineRoot, name);
  if (existsSync(binary)) return binary;

  const encoded = `${binary}.b64`;
  if (!existsSync(encoded)) return null;

  mkdirSync(decodedBaselineRoot, { recursive: true });
  const decoded = join(decodedBaselineRoot, name);
  const base64 = readFileSync(encoded, "utf8").replace(/\s+/g, "");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error(`encoded visual baseline is empty: ${encoded}`);
  writeFileSync(decoded, bytes);
  return decoded;
};

const listFilesRecursively = (directory) => {
  const entries = readdirSync(directory).sort((a, b) => a.localeCompare(b, "en"));
  const files = [];
  for (const name of entries) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...listFilesRecursively(path));
    else if (stats.isFile()) files.push(path);
  }
  return files;
};

const pngs = readdirSync(root).filter((name) => name.endsWith(".png")).sort((a, b) => a.localeCompare(b, "en"));
if (!pngs.length) throw new Error("no browser capture PNG files were produced");

const comparisons = [];
for (const name of pngs) {
  const current = join(root, name);
  const baseline = resolveBaseline(name);
  if (!baseline) {
    comparisons.push({ capture: name, verdict: "NOT_TESTED", reason: "baseline-not-present", currentSha256: sha256File(current) });
    continue;
  }

  let dimensions;
  try {
    const text = execFileSync("identify", ["-format", "%w %h", current], { encoding: "utf8" }).trim();
    const [width, height] = text.split(/\s+/).map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("invalid dimensions");
    dimensions = { width, height };
  } catch (error) {
    throw new Error(`cannot inspect capture dimensions for ${name}`, { cause: error });
  }

  let changedPixels = 0;
  try {
    execFileSync("compare", ["-metric", "AE", "-fuzz", "3%", baseline, current, "null:"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const parsed = Number(stderr.match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
    if (!Number.isFinite(parsed)) throw new Error(`visual comparison failed for ${name}`, { cause: error });
    changedPixels = parsed;
  }

  const totalPixels = dimensions.width * dimensions.height;
  const changedRatio = changedPixels / totalPixels;
  comparisons.push({
    capture: name,
    verdict: changedRatio <= maxChangedRatio ? "PASS" : "FAIL",
    changedPixels,
    totalPixels,
    changedRatio: Number(changedRatio.toFixed(8)),
    maximumChangedRatio: maxChangedRatio,
    currentSha256: sha256File(current),
    baselineSha256: sha256File(baseline),
  });
}

const evidenceFiles = listFilesRecursively(root)
  .filter((path) => !normalizePath(relative(root, path)).startsWith("quality-passport-ci"))
  .map((path) => ({
    path: normalizePath(relative(process.cwd(), path)),
    sha256: sha256File(path),
  }))
  .sort((a, b) => a.path.localeCompare(b.path, "en"));

const statuses = comparisons.map((item) => item.verdict);
const visualVerdict = statuses.includes("FAIL") ? "FAIL" : statuses.every((status) => status === "PASS") ? "PASS" : "NOT_TESTED";
const payload = {
  authority: "NEXUS_CI_QUALITY_PASSPORT_V1",
  projectId: process.env.NEXUS_PROJECT_ID || "UNBOUND",
  sourceRevision,
  engineVersion: packageJson.version,
  generatedAt: new Date().toISOString(),
  runner: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
  visualRegression: {
    verdict: visualVerdict,
    baselineDirectory: normalizePath(baselineRoot),
    comparisons,
  },
  evidence: evidenceFiles,
};
const canonical = JSON.stringify(payload);
const passport = { ...payload, passportSha256: createHash("sha256").update(canonical).digest("hex") };
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "quality-passport-ci.json"), `${JSON.stringify(passport, null, 2)}\n`);

console.log(`NEXUS visual regression: ${visualVerdict}`);
for (const item of comparisons) console.log(`${item.verdict}\t${item.capture}${item.changedRatio !== undefined ? `\tchanged=${item.changedRatio}` : ""}`);
console.log(`Quality Passport: ${join(root, "quality-passport-ci.json")}`);

if (visualVerdict === "FAIL") process.exit(2);
