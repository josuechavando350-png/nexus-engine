import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const MAX_CANDIDATES = 64;
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STDIO = 1_000_000;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const NON_CLAIM = "SEARCH_SPACE_MINIMUM_ONLY_NOT_GLOBAL_IMAGE_OPTIMUM_OR_BROWSER_SUPPORT_PROOF" as const;
export type Codec = "AVIF" | "JXL";
export type QualityTier = "HIGH" | "EXCELLENT" | "VISUALLY_LOSSLESS";
export type ToolchainStatus = "AVAILABLE" | "UNAVAILABLE";
export type OptimizationStatus = "READY" | "NO_PASSING_CANDIDATE" | "UNAVAILABLE";

export interface CandidatePolicy {
  tier: QualityTier;
  minimumSavingsRatio: number;
  avif: readonly { quality: number; speed: number; chroma: "444" | "420" }[];
  jxl: readonly { distance: number; effort: number }[];
}
export interface BinaryInfo { name: string; path: string; version: string; sha256: string; }
export interface ToolchainEvidence {
  status: ToolchainStatus;
  binaries: readonly BinaryInfo[];
  missing: readonly string[];
  digest: string;
}
export interface CandidateResult {
  codec: Codec;
  key: string;
  bytes: number;
  score: number;
  outputPath: string;
  outputSha256: string;
  passing: boolean;
}
export interface OptimizationReport {
  status: OptimizationStatus;
  sourcePath: string;
  sourceSha256: string;
  sourceBytes: number;
  width: number;
  height: number;
  threshold: number;
  minimumSavingsRatio: number;
  toolchain: ToolchainEvidence;
  candidates: readonly CandidateResult[];
  selected: Partial<Record<Codec, CandidateResult>>;
  digest: string;
  nonClaim: typeof NON_CLAIM;
}
export interface ToolPaths { avifenc: string; avifdec: string; cjxl: string; djxl: string; ssimulacra2: string; }
export interface CommandResult { stdout: string; stderr: string; }
export type CommandRunner = (file: string, args: readonly string[], options: { timeoutMs: number }) => Promise<CommandResult>;

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("cyclic value");
    seen.add(value);
    const out = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("cyclic value");
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("non-plain object");
    seen.add(value);
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (RESERVED_KEYS.has(key)) throw new Error(`reserved key ${key}`);
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`undefined at ${key}`);
      out[key] = canonicalize(item, seen);
    }
    seen.delete(value);
    return out;
  }
  throw new Error(`unsupported ${typeof value}`);
}
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
export const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const sha256Bytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function thresholdForTier(tier: QualityTier): number {
  return tier === "HIGH" ? 70 : tier === "EXCELLENT" ? 85 : 90;
}

export function createPolicy(input: CandidatePolicy): CandidatePolicy {
  const threshold = thresholdForTier(input.tier);
  void threshold;
  if (!Number.isFinite(input.minimumSavingsRatio) || input.minimumSavingsRatio < 0 || input.minimumSavingsRatio >= 1) throw new Error("minimumSavingsRatio must be in [0,1)");
  if (input.avif.length + input.jxl.length === 0) throw new Error("candidate space empty");
  if (input.avif.length + input.jxl.length > MAX_CANDIDATES) throw new Error(`candidate space exceeds ${MAX_CANDIDATES}`);
  const avif = input.avif.map((candidate) => {
    if (!Number.isInteger(candidate.quality) || candidate.quality < 0 || candidate.quality > 100) throw new Error("AVIF quality must be integer 0..100");
    if (!Number.isInteger(candidate.speed) || candidate.speed < 0 || candidate.speed > 10) throw new Error("AVIF speed must be integer 0..10");
    return { ...candidate };
  }).sort((a, b) => a.quality - b.quality || a.speed - b.speed || a.chroma.localeCompare(b.chroma));
  const jxl = input.jxl.map((candidate) => {
    if (!Number.isFinite(candidate.distance) || candidate.distance < 0 || candidate.distance > 25) throw new Error("JXL distance must be 0..25");
    if (!Number.isInteger(candidate.effort) || candidate.effort < 1 || candidate.effort > 10) throw new Error("JXL effort must be integer 1..10");
    return { ...candidate };
  }).sort((a, b) => a.distance - b.distance || a.effort - b.effort);
  return Object.freeze({ tier: input.tier, minimumSavingsRatio: input.minimumSavingsRatio, avif, jxl });
}

export const defaultPolicy = (): CandidatePolicy => createPolicy({
  tier: "EXCELLENT",
  minimumSavingsRatio: 0.08,
  avif: [
    { quality: 55, speed: 6, chroma: "420" },
    { quality: 65, speed: 6, chroma: "420" },
    { quality: 75, speed: 4, chroma: "444" },
  ],
  jxl: [
    { distance: 2.5, effort: 7 },
    { distance: 1.5, effort: 7 },
    { distance: 1, effort: 8 },
  ],
});

export const defaultRunner: CommandRunner = async (file, args, options) => {
  try {
    const result = await execFileAsync(file, [...args], { timeout: Math.min(options.timeoutMs, MAX_TIMEOUT_MS), maxBuffer: MAX_STDIO, windowsHide: true });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`command failed: ${basename(file)} ${args.join(" ")} :: ${message}`);
  }
};

async function hashFile(path: string): Promise<string> { return sha256Bytes(await readFile(path)); }
function safeToolPath(path: string): string {
  const resolved = resolve(path);
  if (!resolved.trim()) throw new Error("empty tool path");
  return resolved;
}

export async function inspectToolchain(paths: ToolPaths, runner: CommandRunner = defaultRunner): Promise<ToolchainEvidence> {
  const entries = Object.entries(paths) as [keyof ToolPaths, string][];
  const binaries: BinaryInfo[] = [];
  const missing: string[] = [];
  for (const [name, rawPath] of entries) {
    const path = safeToolPath(rawPath);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      const versionResult = await runner(path, ["--version"], { timeoutMs: 10_000 }).catch(async () => runner(path, ["-version"], { timeoutMs: 10_000 }));
      const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim().slice(0, 500);
      binaries.push({ name, path, version, sha256: await hashFile(path) });
    } catch {
      missing.push(name);
    }
  }
  binaries.sort((a, b) => a.name.localeCompare(b.name));
  missing.sort();
  const core = { status: missing.length === 0 ? "AVAILABLE" as const : "UNAVAILABLE" as const, binaries, missing };
  return { ...core, digest: digest(core) };
}

export async function normalizeReference(sourcePath: string, outputPath: string): Promise<{ width: number; height: number; bytes: number; sha256: string }> {
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error("source must be a file");
  if (source.size <= 0 || source.size > MAX_INPUT_BYTES) throw new Error(`source size must be 1..${MAX_INPUT_BYTES}`);
  const image = sharp(sourcePath, { animated: false, failOn: "error" }).rotate().toColourspace("srgb").removeAlpha();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("source dimensions unavailable");
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await image.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toFile(outputPath);
  const bytes = (await stat(outputPath)).size;
  return { width: metadata.width, height: metadata.height, bytes, sha256: await hashFile(outputPath) };
}

export function parseSsimulacra2(output: string): number {
  const matches = output.match(/-?\d+(?:\.\d+)?/gu);
  if (!matches?.length) throw new Error("SSIMULACRA2 score missing");
  const score = Number(matches.at(-1));
  if (!Number.isFinite(score) || score > 100) throw new Error("invalid SSIMULACRA2 score");
  return score;
}

function savingsPass(bytes: number, sourceBytes: number, ratio: number): boolean {
  return bytes <= Math.floor(sourceBytes * (1 - ratio));
}

async function runCandidate(args: {
  codec: Codec; key: string; referencePath: string; encodedPath: string; decodedPath: string; sourceBytes: number; threshold: number; minimumSavingsRatio: number;
  encode: () => Promise<void>; decode: () => Promise<void>; metricPath: string; runner: CommandRunner;
}): Promise<CandidateResult> {
  await args.encode();
  const encodedStat = await stat(args.encodedPath);
  if (!encodedStat.isFile() || encodedStat.size <= 0) throw new Error(`${args.key} encoder emitted no file`);
  await args.decode();
  const normalizedDecoded = `${args.decodedPath}.normalized.png`;
  await normalizeReference(args.decodedPath, normalizedDecoded);
  const metric = await args.runner(args.metricPath, [args.referencePath, normalizedDecoded], { timeoutMs: 30_000 });
  const score = parseSsimulacra2(`${metric.stdout}\n${metric.stderr}`);
  const result: CandidateResult = {
    codec: args.codec,
    key: args.key,
    bytes: encodedStat.size,
    score,
    outputPath: args.encodedPath,
    outputSha256: await hashFile(args.encodedPath),
    passing: score >= args.threshold && savingsPass(encodedStat.size, args.sourceBytes, args.minimumSavingsRatio),
  };
  return result;
}

export function selectSmallestPassing(results: readonly CandidateResult[], codec: Codec): CandidateResult | undefined {
  return results.filter((result) => result.codec === codec && result.passing).sort((a, b) => a.bytes - b.bytes || b.score - a.score || a.key.localeCompare(b.key))[0];
}

export async function optimizeImage(input: {
  sourcePath: string;
  outputDir: string;
  tools: ToolPaths;
  policy?: CandidatePolicy;
  runner?: CommandRunner;
}): Promise<OptimizationReport> {
  const runner = input.runner ?? defaultRunner;
  const policy = createPolicy(input.policy ?? defaultPolicy());
  const toolchain = await inspectToolchain(input.tools, runner);
  const sourcePath = resolve(input.sourcePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_INPUT_BYTES) throw new Error("invalid source file");
  const sourceSha256 = await hashFile(sourcePath);
  const threshold = thresholdForTier(policy.tier);
  if (toolchain.status === "UNAVAILABLE") {
    const core = { status: "UNAVAILABLE" as const, sourcePath, sourceSha256, sourceBytes: sourceStat.size, width: 0, height: 0, threshold, minimumSavingsRatio: policy.minimumSavingsRatio, toolchain, candidates: [] as CandidateResult[], selected: {}, nonClaim: NON_CLAIM };
    return { ...core, digest: digest(core) };
  }

  const work = await mkdtemp(join(tmpdir(), "nexus-perceptual-"));
  try {
    const referencePath = join(work, "reference.png");
    const reference = await normalizeReference(sourcePath, referencePath);
    const candidates: CandidateResult[] = [];
    const outputDir = resolve(input.outputDir);
    await mkdir(outputDir, { recursive: true });

    for (const candidate of policy.avif) {
      const key = `avif-q${candidate.quality}-s${candidate.speed}-${candidate.chroma}`;
      const encoded = join(work, `${key}.avif`);
      const decoded = join(work, `${key}.png`);
      candidates.push(await runCandidate({ codec: "AVIF", key, referencePath, encodedPath: encoded, decodedPath: decoded, sourceBytes: sourceStat.size, threshold, minimumSavingsRatio: policy.minimumSavingsRatio, metricPath: input.tools.ssimulacra2, runner,
        encode: async () => { await runner(input.tools.avifenc, ["--qcolor", String(candidate.quality), "--qalpha", String(candidate.quality), "--speed", String(candidate.speed), "--jobs", "1", "--yuv", candidate.chroma, referencePath, encoded], { timeoutMs: 60_000 }); },
        decode: async () => { await runner(input.tools.avifdec, [encoded, decoded], { timeoutMs: 30_000 }); },
      }));
    }
    for (const candidate of policy.jxl) {
      const key = `jxl-d${candidate.distance}-e${candidate.effort}`;
      const encoded = join(work, `${key}.jxl`);
      const decoded = join(work, `${key}.png`);
      candidates.push(await runCandidate({ codec: "JXL", key, referencePath, encodedPath: encoded, decodedPath: decoded, sourceBytes: sourceStat.size, threshold, minimumSavingsRatio: policy.minimumSavingsRatio, metricPath: input.tools.ssimulacra2, runner,
        encode: async () => { await runner(input.tools.cjxl, [referencePath, encoded, "--distance", String(candidate.distance), "--effort", String(candidate.effort), "--num_threads", "1"], { timeoutMs: 60_000 }); },
        decode: async () => { await runner(input.tools.djxl, [encoded, decoded, "--num_threads", "1"], { timeoutMs: 30_000 }); },
      }));
    }

    candidates.sort((a, b) => a.codec.localeCompare(b.codec) || a.key.localeCompare(b.key));
    const avif = selectSmallestPassing(candidates, "AVIF");
    const jxl = selectSmallestPassing(candidates, "JXL");
    const selected: Partial<Record<Codec, CandidateResult>> = {};
    const stem = basename(sourcePath, extname(sourcePath));
    if (avif) {
      const target = join(outputDir, `${stem}.${avif.outputSha256.slice(0, 12)}.avif`);
      await copyFile(avif.outputPath, target); await chmod(target, 0o644); selected.AVIF = { ...avif, outputPath: target };
    }
    if (jxl) {
      const target = join(outputDir, `${stem}.${jxl.outputSha256.slice(0, 12)}.jxl`);
      await copyFile(jxl.outputPath, target); await chmod(target, 0o644); selected.JXL = { ...jxl, outputPath: target };
    }
    const status: OptimizationStatus = avif || jxl ? "READY" : "NO_PASSING_CANDIDATE";
    const core = { status, sourcePath, sourceSha256, sourceBytes: sourceStat.size, width: reference.width, height: reference.height, threshold, minimumSavingsRatio: policy.minimumSavingsRatio, toolchain, candidates, selected, nonClaim: NON_CLAIM };
    return { ...core, digest: digest(core) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function escapeHtml(value: string): string { return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;"); }
function safeAssetUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || /[\r\n]/u.test(trimmed)) throw new Error("asset URL must be root-relative");
  return trimmed;
}
export function renderPicture(input: { jxl?: string; avif?: string; fallback: string; alt: string; width: number; height: number; loading?: "lazy" | "eager" }): string {
  if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) throw new Error("valid dimensions required");
  const fallback = safeAssetUrl(input.fallback);
  const sources = [
    input.jxl ? `<source type="image/jxl" srcset="${escapeHtml(safeAssetUrl(input.jxl))}">` : "",
    input.avif ? `<source type="image/avif" srcset="${escapeHtml(safeAssetUrl(input.avif))}">` : "",
  ].filter(Boolean);
  return ["<picture>", ...sources, `<img src="${escapeHtml(fallback)}" alt="${escapeHtml(input.alt)}" width="${input.width}" height="${input.height}" loading="${input.loading ?? "lazy"}" decoding="async">`, "</picture>"].join("\n");
}

export async function writeReport(path: string, report: OptimizationReport): Promise<void> {
  const verified = { ...report, digest: undefined } as unknown as Record<string, unknown>;
  delete verified.digest;
  if (digest(verified) !== report.digest) throw new Error("report digest mismatch");
  await writeFile(path, `${canonicalJson(report)}\n`, { encoding: "utf8", mode: 0o644 });
}
