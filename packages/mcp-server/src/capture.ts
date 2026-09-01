import { basename, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CaptureArtifact, CaptureCapability, CaptureRequest } from "@nexus/capture";
import type { CaptureViewport, SupportedBrowser } from "@nexus/capture/playwright";
import type { MetricSample } from "@nexus/measurement";
import { pathToFileURL } from "node:url";
import type { ProjectState } from "./contracts.js";
import { withProjectServer } from "./project-server.js";

export interface CaptureInput { source: { target: string } | { url: string }; sourceSha?: string; viewports?: { mobile?: { width: number; height: number }; desktop?: { width: number; height: number } }; fullPage?: boolean }
export interface CaptureOutput { captures: readonly { viewport: "mobile" | "desktop"; width: number; height: number; browser: string; finalUrl: string; artifact: { path: string; mediaType: "image/png"; byteLength: number; sha256: string; url: string } }[] }

export interface ProjectCaptureOptions {
  capabilities?: readonly CaptureCapability[];
  browsers?: readonly SupportedBrowser[];
  viewports?: readonly CaptureViewport[];
}

export interface ProjectCaptureEvidence {
  requestId: string;
  runId: string;
  targetUrl: string;
  artifacts: readonly CaptureArtifact[];
  samples: readonly MetricSample[];
}

export async function captureProjectEvidence(
  root: string,
  project: ProjectState,
  sourceSha: string,
  requestId: string,
  artifactRoot = join(tmpdir(), "nexus-mcp-artifacts"),
  options: ProjectCaptureOptions = {},
): Promise<ProjectCaptureEvidence> {
  const captureModule = await import(pathToFileURL(join(root, "packages", "capture", "dist", "capture", "index.js")).href) as typeof import("@nexus/capture");
  const playwrightModule = await import(pathToFileURL(join(root, "packages", "capture", "dist", "capture", "playwright-adapter.js")).href) as typeof import("@nexus/capture/playwright");
  const measurementModule = await import(pathToFileURL(join(root, "packages", "measurement", "dist", "measurement", "index.js")).href) as typeof import("@nexus/measurement");
  const { validateCaptureResult } = captureModule;
  const { PlaywrightBrowserDeviceCaptureAdapter } = playwrightModule;
  const { createRun } = measurementModule;
  const capabilities = Object.freeze([...(options.capabilities ?? ["SCREENSHOT"])]);
  if (!capabilities.length || new Set(capabilities).size !== capabilities.length) throw new Error("project capture capabilities must be non-empty and unique");
  return await withProjectServer(root, project, async (url) => {
    const outputDir = join(artifactRoot, requestId);
    const scope = { tenantId: "nexus-mcp", brandId: project.slug };
    const startedAt = new Date().toISOString();
    const browsers = options.browsers ?? ["chromium", "webkit"];
    const run = createRun({ workload: { id: `mcp-capture-${project.slug}`, version: "2", scope, name: "NEXUS project browser evidence", parameters: { target: project.slug, sourceSha, capabilities: capabilities.join(",") } }, environment: { os: process.platform, architecture: process.arch, runtime: "node", runtimeVersion: process.version, deviceClass: "mcp-runner", browser: browsers.join(",") }, scope, startedAt });
    const request: CaptureRequest = { run, scope, targetId: url, capabilities, metadata: { sourceSha, project: project.slug, packageName: project.packageName } };
    const adapterOptions = {
      outputDir,
      ...(options.browsers ? { browsers: options.browsers } : {}),
      ...(options.viewports ? { viewports: options.viewports } : {}),
    };
    const adapter = new PlaywrightBrowserDeviceCaptureAdapter(adapterOptions);
    const result = await adapter.capture(request);
    validateCaptureResult(request, result);
    if (result.outcome !== "CAPTURED") throw new Error(result.reason ?? "capture failed without reason");
    return Object.freeze({ requestId, runId: run.runId, targetUrl: url, artifacts: Object.freeze([...result.artifacts]), samples: Object.freeze([...result.samples]) });
  });
}

export async function captureTarget(root: string, project: ProjectState, sourceSha: string, requestId: string, artifactRoot = join(tmpdir(), "nexus-mcp-artifacts"), viewports?: CaptureInput["viewports"]): Promise<CaptureOutput> {
  const mobile = { name: "mobile", width: viewports?.mobile?.width ?? 390, height: viewports?.mobile?.height ?? 844 };
  const desktop = { name: "desktop", width: viewports?.desktop?.width ?? 1440, height: viewports?.desktop?.height ?? 1000 };
  const evidence = await captureProjectEvidence(root, project, sourceSha, requestId, artifactRoot, { capabilities: ["SCREENSHOT"], browsers: ["chromium"], viewports: [mobile, desktop] });
  const captures = evidence.artifacts.filter((artifact) => artifact.capability === "SCREENSHOT").map((artifact) => {
    const viewport = artifact.metadata?.viewport;
    if (viewport !== "mobile" && viewport !== "desktop") throw new Error(`unexpected capture viewport ${viewport ?? "missing"}`);
    if (!artifact.uri) throw new Error("capture artifact URI is missing");
    const name = basename(artifact.uri);
    return { viewport: viewport as "mobile" | "desktop", width: Number(artifact.metadata?.width), height: Number(artifact.metadata?.height), browser: artifact.metadata?.browser ?? "chromium", finalUrl: evidence.targetUrl, artifact: { path: relative(root, artifact.uri).split(sep).join("/"), mediaType: "image/png" as const, byteLength: artifact.byteLength, sha256: artifact.digest.replace(/^sha256:/, ""), url: `/artifacts/${requestId}/${encodeURIComponent(name)}` } };
  });
  if (captures.length !== 2) throw new Error(`expected 2 screenshots, captured ${captures.length}`);
  return { captures: Object.freeze(captures) };
}
