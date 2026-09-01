import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildExecution } from "./build.js";
import { buildTarget, validateBuildManifest } from "./build.js";
import type { ProjectState } from "./contracts.js";
import { withProjectServer } from "./project-server.js";
import { runReadOnly } from "./process.js";

const MAX_BASELINES = 64;
const MAX_PATH = 1_024;
const MAX_ROUTE = 2_048;
const CANONICAL_SCENE_HOST = "nexus.invalid";

type BrowserName = "chromium" | "webkit";
interface Viewport { name: string; width: number; height: number }
interface SceneInput { id: string; url: string; fullPage?: boolean; masks?: readonly unknown[]; policy?: Record<string, unknown> }
interface Scene extends SceneInput { fullPage: boolean; masks: readonly unknown[]; policy: Record<string, number>; digest: string }
interface ApprovedBaseline {
  sceneDigest: string;
  buildDigest: string;
  environment: { browserName: BrowserName; [key: string]: unknown };
  viewport: Viewport;
  screenshotSha256: string;
  approvalReference: string;
  digest: string;
  [key: string]: unknown;
}
interface ComparisonReport {
  verdict: "PASS" | "FAIL" | "INCOMPATIBLE_BASELINE";
  baselineDigest: string;
  captureDigest: string;
  diffSha256?: string;
  diffPath?: string;
  digest: string;
  [key: string]: unknown;
}
interface RuntimeCaptureArtifact {
  record: { screenshotSha256: string; digest: string; [key: string]: unknown };
  path: string;
  navigationUrl: string;
}

interface VisualRegressionModule {
  createScene(input: SceneInput): Scene;
  createViewport(name: string, width: number, height: number): Viewport;
  validateBaseline(baseline: ApprovedBaseline): void;
  createSsimulacra2Comparator(path: string): (baselinePath: string, currentPath: string) => Promise<number>;
  compareCapture(input: { baseline: ApprovedBaseline; baselinePath: string; current: RuntimeCaptureArtifact; policy: Record<string, number>; perceptual: (baselinePath: string, currentPath: string) => Promise<number>; outDir: string }): Promise<ComparisonReport>;
}
interface RuntimeNavigationModule {
  captureSceneAtNavigationUrl(input: { scene: Scene; navigationUrl: string; browserName: BrowserName; viewport: Viewport; revision: string; buildDigest: string; outDir: string }): Promise<RuntimeCaptureArtifact>;
}

export interface VisualComparatorInput {
  source: { target: string };
  sourceSha: string;
  baselineEnvelopePath: string;
}

export interface VisualComparatorDependencies {
  root: string;
  project: ProjectState;
  requestId: string;
  artifactRoot: string;
  ssimulacra2Path?: string;
  buildRunner?: typeof buildTarget;
  buildValidator?: typeof validateBuildManifest;
  visualModuleLoader?: () => Promise<{ visual: VisualRegressionModule; runtime: RuntimeNavigationModule }>;
}

interface BaselineEntry {
  id: string;
  route: string;
  scene: SceneInput;
  browserName: BrowserName;
  viewport: Viewport;
  screenshotPath: string;
  baseline: ApprovedBaseline;
}
interface BaselineEnvelope { schemaVersion: 1; projectId: string; baselines: readonly BaselineEntry[] }

export interface VisualComparatorSceneResult {
  id: string;
  route: string;
  sceneDigest: string;
  browserName: BrowserName;
  viewport: Viewport;
  approvalReference: string;
  baselineDigest: string;
  baselineScreenshotSha256: string;
  currentScreenshotSha256: string;
  captureDigest: string;
  report: ComparisonReport;
  currentScreenshotPath: string;
  diffPath: string | null;
}
export interface VisualComparatorExecution {
  projectId: string;
  sourceSha: string;
  buildDigest: string;
  buildManifestSha256: string;
  baselineEnvelopePath: string;
  baselineEnvelopeSha256: string;
  comparisons: readonly VisualComparatorSceneResult[];
  build: BuildExecution;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

async function loadVisualModules(root: string): Promise<{ visual: VisualRegressionModule; runtime: RuntimeNavigationModule }> {
  const visualUrl = pathToFileURL(join(root, "packages", "capture-visual-regression-v2", "dist", "index.js")).href;
  const runtimeUrl = pathToFileURL(join(root, "packages", "capture-visual-regression-v2", "dist", "runtime-navigation.js")).href;
  const [visual, runtime] = await Promise.all([import(visualUrl), import(runtimeUrl)]);
  return { visual: visual as VisualRegressionModule, runtime: runtime as RuntimeNavigationModule };
}

function repositoryPath(root: string, candidate: string, label: string): { absolute: string; relative: string } {
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > MAX_PATH) throw new Error(`${label} must be a bounded non-empty repository path`);
  if (isAbsolute(candidate)) throw new Error(`${label} must be repository-relative`);
  const absolute = resolve(root, candidate);
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(normalizedRoot)) throw new Error(`${label} must stay inside repository root`);
  return { absolute, relative: absolute.slice(normalizedRoot.length).split(sep).join("/") };
}

async function committedFile(root: string, candidate: string, sourceSha: string, label: string): Promise<{ bytes: Buffer; relativePath: string; sha256: string }> {
  const file = repositoryPath(root, candidate, label);
  const dirty = (await runReadOnly("git", ["status", "--porcelain", "--", file.relative], root)).trim();
  if (dirty) throw new Error(`${label} must be committed and clean`);
  const committedBlob = (await runReadOnly("git", ["rev-parse", `${sourceSha}:${file.relative}`], root)).trim();
  const workingBlob = (await runReadOnly("git", ["hash-object", "--", file.relative], root)).trim();
  if (!/^[a-f0-9]{40}$/u.test(committedBlob) || committedBlob !== workingBlob) throw new Error(`${label} bytes are not identical to the declared source SHA blob`);
  const bytes = await readFile(file.absolute);
  return { bytes, relativePath: file.relative, sha256: sha256(bytes) };
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} must be bounded and non-empty`);
  return normalized;
}
function route(value: unknown): string {
  const candidate = text(value, "baseline route", MAX_ROUTE);
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("#") || candidate.includes("\\")) throw new Error("baseline route must be an absolute same-origin path without fragment");
  const parsed = new URL(candidate, "https://nexus.invalid");
  if (parsed.origin !== "https://nexus.invalid") throw new Error("baseline route must stay on the project origin");
  return `${parsed.pathname}${parsed.search}`;
}
function sameViewport(left: Viewport, right: Viewport): boolean { return left.name === right.name && left.width === right.width && left.height === right.height; }

function parseEnvelope(value: unknown, projectId: string, visual: VisualRegressionModule): BaselineEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("visual baseline envelope must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error("visual baseline envelope schemaVersion must be 1");
  if (record.projectId !== projectId) throw new Error("visual baseline projectId does not match active project");
  if (!Array.isArray(record.baselines) || record.baselines.length < 1 || record.baselines.length > MAX_BASELINES) throw new Error(`visual baseline envelope requires 1-${MAX_BASELINES} baselines`);
  const entries = record.baselines.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`baselines[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const id = text(item.id, `baselines[${index}].id`, 160);
    const runtimeRoute = route(item.route);
    const sceneInput = item.scene as SceneInput;
    const scene = visual.createScene(sceneInput);
    const identity = new URL(scene.url);
    if (identity.protocol !== "https:" || identity.hostname !== CANONICAL_SCENE_HOST) throw new Error(`baselines[${index}].scene.url must use https://${CANONICAL_SCENE_HOST}/ as stable scene identity`);
    if (`${identity.pathname}${identity.search}` !== runtimeRoute) throw new Error(`baselines[${index}] stable scene URL path must equal route`);
    const browserName = item.browserName === "chromium" || item.browserName === "webkit" ? item.browserName : null;
    if (!browserName) throw new Error(`baselines[${index}].browserName must be chromium or webkit`);
    if (!item.viewport || typeof item.viewport !== "object" || Array.isArray(item.viewport)) throw new Error(`baselines[${index}].viewport is required`);
    const viewportRaw = item.viewport as Record<string, unknown>;
    const viewport = visual.createViewport(String(viewportRaw.name ?? ""), Number(viewportRaw.width), Number(viewportRaw.height));
    const screenshotPath = text(item.screenshotPath, `baselines[${index}].screenshotPath`, MAX_PATH);
    const baseline = item.baseline as ApprovedBaseline;
    visual.validateBaseline(baseline);
    if (baseline.sceneDigest !== scene.digest) throw new Error(`baselines[${index}] baseline scene digest does not match scene contract`);
    if (baseline.environment.browserName !== browserName) throw new Error(`baselines[${index}] baseline browser does not match browserName`);
    if (!sameViewport(baseline.viewport, viewport)) throw new Error(`baselines[${index}] baseline viewport does not match viewport contract`);
    return Object.freeze({ id, route: runtimeRoute, scene: sceneInput, browserName, viewport, screenshotPath, baseline });
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("visual baseline ids must be unique");
  const identityKeys = entries.map((entry) => `${entry.id}\0${entry.browserName}\0${entry.viewport.name}`);
  if (new Set(identityKeys).size !== entries.length) throw new Error("visual baseline scene/browser/viewport identities must be unique");
  return Object.freeze({ schemaVersion: 1, projectId, baselines: Object.freeze(entries) });
}

function runtimeUrl(origin: string, runtimeRoute: string): string {
  const target = new URL(runtimeRoute, origin);
  if (target.origin !== new URL(origin).origin) throw new Error("runtime scene escaped the governed project server origin");
  return target.toString();
}

export async function runVisualComparator(input: VisualComparatorInput, dependencies: VisualComparatorDependencies): Promise<VisualComparatorExecution> {
  if (input.source.target !== dependencies.project.slug) throw new Error("visual comparator target does not match resolved project");
  const modules = await (dependencies.visualModuleLoader ?? (() => loadVisualModules(dependencies.root)))();
  const envelopeFile = await committedFile(dependencies.root, input.baselineEnvelopePath, input.sourceSha, "visual baseline envelope");
  const envelope = parseEnvelope(JSON.parse(envelopeFile.bytes.toString("utf8")), dependencies.project.slug, modules.visual);
  const baselineFiles = new Map<string, { absolute: string; sha256: string }>();
  for (const entry of envelope.baselines) {
    const verified = await committedFile(dependencies.root, entry.screenshotPath, input.sourceSha, `baseline screenshot ${entry.id}`);
    if (verified.sha256 !== entry.baseline.screenshotSha256) throw new Error(`baseline screenshot ${entry.id} hash does not match approved baseline`);
    baselineFiles.set(entry.id, { absolute: join(dependencies.root, verified.relativePath), sha256: verified.sha256 });
  }

  const execution = await (dependencies.buildRunner ?? buildTarget)(dependencies.root, dependencies.project, input.sourceSha, `${dependencies.requestId}-visual-build`);
  if (execution.unavailableReason || execution.exitCode === null) throw new Error("VISUAL_BUILD_UNAVAILABLE");
  if (execution.exitCode !== 0 || !execution.manifest) throw new Error("VISUAL_BUILD_FAILED");
  if (!await (dependencies.buildValidator ?? validateBuildManifest)(dependencies.root, dependencies.project, input.sourceSha, execution.manifest)) throw new Error("VISUAL_BUILD_MANIFEST_INVALID");
  const buildDigest = execution.manifest.outputDigest;
  if (!/^[a-f0-9]{64}$/u.test(buildDigest)) throw new Error("VISUAL_BUILD_MANIFEST_INVALID");
  if (!dependencies.ssimulacra2Path || !dependencies.ssimulacra2Path.trim()) throw new Error("PERCEPTUAL_COMPARATOR_UNAVAILABLE");
  const perceptual = modules.visual.createSsimulacra2Comparator(dependencies.ssimulacra2Path);

  const comparisons = await withProjectServer(dependencies.root, dependencies.project, async (origin) => {
    const results: VisualComparatorSceneResult[] = [];
    for (const entry of envelope.baselines) {
      const scene = modules.visual.createScene(entry.scene);
      const baselineFile = baselineFiles.get(entry.id)!;
      const current = await modules.runtime.captureSceneAtNavigationUrl({ scene, navigationUrl: runtimeUrl(origin, entry.route), browserName: entry.browserName, viewport: entry.viewport, revision: input.sourceSha, buildDigest, outDir: join(dependencies.artifactRoot, dependencies.requestId, "visual-regression", entry.id) });
      const report = await modules.visual.compareCapture({ baseline: entry.baseline, baselinePath: baselineFile.absolute, current, policy: scene.policy, perceptual, outDir: join(dependencies.artifactRoot, dependencies.requestId, "visual-regression", entry.id, "diff") });
      results.push(Object.freeze({ id: entry.id, route: entry.route, sceneDigest: scene.digest, browserName: entry.browserName, viewport: entry.viewport, approvalReference: entry.baseline.approvalReference, baselineDigest: entry.baseline.digest, baselineScreenshotSha256: entry.baseline.screenshotSha256, currentScreenshotSha256: current.record.screenshotSha256, captureDigest: current.record.digest, report, currentScreenshotPath: current.path, diffPath: report.diffPath ?? null }));
    }
    return Object.freeze(results);
  });
  return Object.freeze({ projectId: dependencies.project.slug, sourceSha: input.sourceSha, buildDigest, buildManifestSha256: execution.manifest.manifestSha256, baselineEnvelopePath: envelopeFile.relativePath, baselineEnvelopeSha256: envelopeFile.sha256, comparisons, build: execution });
}
