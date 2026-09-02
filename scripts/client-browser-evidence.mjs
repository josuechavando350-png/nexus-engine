#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CLIENT_BROWSER_VIEWPORTS as REQUIRED_VIEWPORTS,
  parsePngDimensions,
  sealClientBrowserEvidence,
  verifyClientBrowserEvidenceSeal,
} from "./client-browser-evidence-contract.mjs";
import { prepareProjectCaptureRuntime } from "./project-capture-runtime.mjs";
import { installRepositoryTypeScriptRuntime } from "./typescript-source-runtime.mjs";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BUILD_ERROR_EXCERPT_BYTES = 4096;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalizePath = (path) => path.split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function sanitizeTerminalText(value) {
  let printable = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable += character;
  }
  return printable.replace(/\[[0-9;?]*[A-Za-z]/g, "");
}

function buildErrorExcerpt(bytes) {
  if (!bytes?.byteLength) return "";
  return sanitizeTerminalText(bytes
    .subarray(Math.max(0, bytes.byteLength - MAX_BUILD_ERROR_EXCERPT_BYTES))
    .toString("utf8"))
    .trim();
}

async function confinedRegularFile(path, root, label) {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const [rootReal, fileReal] = await Promise.all([realpath(root), realpath(path)]);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) throw new Error(`${label} resolves outside its evidence root`);
  return fileReal;
}

async function main() {
  const [projectId, ...extra] = process.argv.slice(2);
  if (!projectId || extra.length || !PROJECT_ID.test(projectId)) {
    throw new Error("usage: node scripts/client-browser-evidence.mjs <kebab-case-project-id>");
  }

  const sourceRevision = (process.env.NEXUS_VALIDATED_SHA || git(["rev-parse", "HEAD"])).trim();
  if (!SHA1.test(sourceRevision)) throw new Error("NEXUS_VALIDATED_SHA must be a full lowercase Git SHA-1");
  const head = git(["rev-parse", "HEAD"]);
  if (head !== sourceRevision) throw new Error(`browser evidence source SHA mismatch: expected ${sourceRevision}, HEAD is ${head}`);
  if (git(["status", "--porcelain"])) {
    throw new Error("client browser evidence requires a completely clean worktree, including untracked files, before exact-SHA build execution");
  }

  await prepareProjectCaptureRuntime(repositoryRoot);
  if (git(["status", "--porcelain"])) {
    throw new Error("project capture runtime preparation modified repository source bytes; exact-SHA evidence requires source to remain clean");
  }

  const hooks = installRepositoryTypeScriptRuntime();
  try {
    const [{ readProjects }, { buildTarget, validateBuildManifest }, { captureProjectEvidence }] = await Promise.all([
      import("../packages/mcp-server/src/projects.ts"),
      import("../packages/mcp-server/src/build.ts"),
      import("../packages/mcp-server/src/capture.ts"),
    ]);

    const projects = await readProjects(repositoryRoot);
    const project = projects.find((candidate) => candidate.slug === projectId);
    if (!project) throw new Error(`browser evidence target ${projectId} is not a discovered workspace app`);
    if (!project.workspaceMember) throw new Error(`browser evidence target ${projectId} is not a workspace member`);

    const captureRoot = join(repositoryRoot, "artifacts", "browser-capture", projectId);
    await rm(captureRoot, { recursive: true, force: true });
    await mkdir(captureRoot, { recursive: true });

    const requestId = `passport-${projectId}-${sourceRevision.slice(0, 12)}`;
    const build = await buildTarget(repositoryRoot, project, sourceRevision, `${requestId}-build`);
    if (!build.manifest) {
      const buildLog = await readFile(build.logPath).catch(() => Buffer.alloc(0));
      if (buildLog.byteLength) await writeFile(join(captureRoot, "build-failure.log"), buildLog);
      const excerpt = buildErrorExcerpt(buildLog);
      const reason = build.unavailableReason
        ? `exact-SHA client build unavailable: ${build.unavailableReason}`
        : `exact-SHA client build failed with exit ${build.exitCode ?? "unknown"}`;
      throw new Error(excerpt ? `${reason}\nBuild log tail:\n${excerpt}` : reason);
    }
    if (!(await validateBuildManifest(repositoryRoot, project, sourceRevision, build.manifest))) {
      throw new Error("exact-SHA client build manifest failed integrity validation");
    }

    const buildManifestPath = join(captureRoot, "build-manifest.json");
    await writeFile(buildManifestPath, `${JSON.stringify(build.manifest, null, 2)}\n`, "utf8");

    const capture = await captureProjectEvidence(
      repositoryRoot,
      project,
      sourceRevision,
      requestId,
      captureRoot,
      { capabilities: ["SCREENSHOT"], browsers: ["chromium"], viewports: REQUIRED_VIEWPORTS },
    );

    const screenshots = capture.artifacts.filter((artifact) => artifact.capability === "SCREENSHOT");
    if (screenshots.length !== REQUIRED_VIEWPORTS.length) {
      throw new Error(`expected ${REQUIRED_VIEWPORTS.length} exact-SHA screenshots, captured ${screenshots.length}`);
    }

    const captures = [];
    for (const viewport of REQUIRED_VIEWPORTS) {
      const matches = screenshots.filter((artifact) => artifact.metadata?.browser === "chromium" && artifact.metadata?.viewport === viewport.name);
      if (matches.length !== 1) throw new Error(`expected exactly one chromium screenshot for ${viewport.name}, observed ${matches.length}`);
      const artifact = matches[0];
      if (!artifact.uri) throw new Error(`screenshot ${viewport.name} is missing a file URI`);
      const fileReal = await confinedRegularFile(artifact.uri, captureRoot, `screenshot ${viewport.name}`);
      const bytes = await readFile(fileReal);
      const observedDigest = sha256(bytes);
      const declaredDigest = String(artifact.digest ?? "").replace(/^sha256:/, "");
      if (!SHA256.test(declaredDigest) || declaredDigest !== observedDigest) throw new Error(`screenshot ${viewport.name} digest does not match persisted bytes`);
      if (artifact.byteLength !== bytes.byteLength) throw new Error(`screenshot ${viewport.name} byte length does not match persisted bytes`);
      const viewportWidth = Number(artifact.metadata?.width);
      const viewportHeight = Number(artifact.metadata?.height);
      if (viewportWidth !== viewport.width || viewportHeight !== viewport.height) throw new Error(`screenshot ${viewport.name} viewport metadata is inconsistent`);
      const imageDimensions = parsePngDimensions(bytes, `screenshot ${viewport.name}`);
      if (imageDimensions.width !== viewport.width) throw new Error(`screenshot ${viewport.name} full-page PNG width does not match viewport`);
      if (imageDimensions.height < viewport.height) throw new Error(`screenshot ${viewport.name} full-page PNG is shorter than viewport`);
      captures.push(Object.freeze({
        browser: "chromium",
        viewport: viewport.name,
        viewportWidth,
        viewportHeight,
        imageWidth: imageDimensions.width,
        imageHeight: imageDimensions.height,
        path: normalizePath(relative(repositoryRoot, fileReal)),
        byteLength: bytes.byteLength,
        sha256: observedDigest,
      }));
    }

    const payload = {
      schemaVersion: 1,
      authority: "NEXUS_CLIENT_BROWSER_EVIDENCE_V1",
      projectId,
      sourceRevision,
      route: "/",
      requestId: capture.requestId,
      runId: capture.runId,
      build: {
        authority: build.manifest.authority,
        target: build.manifest.target,
        manifestPath: normalizePath(relative(repositoryRoot, buildManifestPath)),
        manifestSha256: build.manifest.manifestSha256,
        outputDigest: build.manifest.outputDigest,
      },
      captures,
    };
    const manifest = sealClientBrowserEvidence(payload);
    const manifestPath = join(captureRoot, "evidence-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (!verifyClientBrowserEvidenceSeal(manifest)) throw new Error("client browser evidence manifest seal failed self-verification");

    process.stdout.write(`${normalizePath(relative(repositoryRoot, manifestPath))}\n`);
  } finally {
    hooks.deregister();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => { console.error(error); process.exitCode = 1; });
