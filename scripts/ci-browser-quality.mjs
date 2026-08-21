import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const root = process.env.NEXUS_CAPTURE_EVIDENCE_DIR || "artifacts/browser-capture";
const baselineRoot = process.env.NEXUS_VISUAL_BASELINE_DIR || "quality-baselines/browser-capture";
const maxChangedRatio = Number(process.env.NEXUS_VISUAL_MAX_CHANGED_RATIO || "0.001");
const sourceRevision = process.env.NEXUS_VALIDATED_SHA || process.env.GITHUB_SHA || "UNKNOWN";
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

if (!existsSync(root)) throw new Error(`capture evidence directory does not exist: ${root}`);
if (!Number.isFinite(maxChangedRatio) || maxChangedRatio < 0 || maxChangedRatio > 1) {
  throw new Error("NEXUS_VISUAL_MAX_CHANGED_RATIO must be in [0,1]");
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pngs = readdirSync(root).filter((name) => name.endsWith(".png")).sort();
if (!pngs.length) throw new Error("no browser capture PNG files were produced");

const comparisons = [];
for (const name of pngs) {
  const current = join(root, name);
  const baseline = join(baselineRoot, name);
  if (!existsSync(baseline)) {
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
    throw new Error(`cannot inspect capture dimensions for ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let changedPixels = 0;
  try {
    execFileSync("compare", ["-metric", "AE", "-fuzz", "3%", baseline, current, "null:"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const parsed = Number(stderr.match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
    if (!Number.isFinite(parsed)) throw new Error(`visual comparison failed for ${name}: ${stderr || error.message}`);
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

const evidenceFiles = readdirSync(root)
  .filter((name) => !name.startsWith("quality-passport-ci"))
  .sort()
  .map((name) => {
    const path = join(root, name);
    return { path: relative(process.cwd(), path), sha256: sha256File(path) };
  });

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
    baselineDirectory: baselineRoot,
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
