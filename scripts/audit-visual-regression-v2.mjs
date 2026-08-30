import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  captureScene,
  compareCapture,
  createScene,
  createSsimulacra2Comparator,
  createViewport,
  validateBaseline,
} from "../packages/capture-visual-regression-v2/src/index.ts";

const args = process.argv.slice(2);
const specIndex = args.indexOf("--spec");
if (specIndex < 0 || !args[specIndex + 1]) throw new Error("usage: node scripts/audit-visual-regression-v2.mjs --spec <visual-regression.json>");
const specPath = resolve(args[specIndex + 1]);
const spec = JSON.parse(await readFile(specPath, "utf8"));
const scene = createScene(spec.scene);
const viewport = createViewport(spec.viewport?.name, spec.viewport?.width, spec.viewport?.height);
const outDir = resolve(spec.outDir);
await mkdir(outDir, { recursive: true });
const capture = await captureScene({
  scene,
  browserName: spec.browserName,
  viewport,
  revision: spec.revision,
  buildDigest: spec.buildDigest,
  outDir,
  navigationTimeoutMs: spec.navigationTimeoutMs,
});
const captureRecordPath = resolve(outDir, `${scene.id}.${spec.browserName}.${viewport.name}.capture.json`);
await writeFile(captureRecordPath, `${JSON.stringify(capture.record, null, 2)}\n`);

if (!spec.baseline) {
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED_ONLY", captureRecordPath, capture }, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(resolve(spec.baseline.manifestPath), "utf8"));
validateBaseline(baseline);
if (typeof spec.ssimulacra2Path !== "string" || !spec.ssimulacra2Path.trim()) {
  throw new Error("ssimulacra2Path is required when comparing against an approved baseline");
}
const report = await compareCapture({
  baseline,
  baselinePath: resolve(spec.baseline.screenshotPath),
  current: capture,
  policy: scene.policy,
  perceptual: createSsimulacra2Comparator(spec.ssimulacra2Path),
  outDir: resolve(outDir, "diff"),
});
const reportPath = resolve(outDir, `${scene.id}.${spec.browserName}.${viewport.name}.comparison.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: report.verdict, captureRecordPath, reportPath, report }, null, 2)}\n`);
process.exitCode = report.verdict === "PASS" ? 0 : report.verdict === "INCOMPATIBLE_BASELINE" ? 3 : 2;
