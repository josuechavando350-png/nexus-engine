#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probeRoot = join(repositoryRoot, "apps", "pipeline-probe");
const requireFromCapture = createRequire(join(repositoryRoot, "packages", "capture", "package.json"));
const requireFromProbe = createRequire(join(probeRoot, "package.json"));
const nextCli = requireFromProbe.resolve("next/dist/bin/next");
const { chromium } = requireFromCapture("playwright");
const port = 39182;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const featureContractId = "NEXUS_WEB_FRICTION_SIGNALS_V1";
const scorePath = "/api/cortex/friction/score";
const controlPath = "/api/cortex/friction/control";
const calibrationFixture = JSON.stringify({
  authority: "NEXUS_CORTEX_09_CI_CALIBRATION_FIXTURE_V1",
  fixtureOnly: true,
  note: "Browser integration proof only. Not a production calibration artifact.",
});
const calibrationSourceDigest = sha256(calibrationFixture);
const model = Object.freeze({
  schemaVersion: 1,
  featureContractId,
  modelId: "ci-browser-proof-not-production",
  sourceDigest: calibrationSourceDigest,
  intercept: -4,
  coefficients: Object.freeze({
    interactionLatency: 2,
    validationErrorRatio: 2,
    repeatedActionRatio: 2,
    longTaskRate: 2,
    visibilityLossRate: 2,
    scrollDeficit: 2,
    coarsePointerIndicator: 0,
  }),
  lowRiskMax: 0.33,
  mediumRiskMax: 0.66,
});
const modelJson = JSON.stringify(model);
const modelArtifactDigest = sha256(modelJson);
const snapshotKeys = [
  "elapsedMs",
  "featureContractId",
  "interactionCount",
  "longTaskCount",
  "maxInteractionLatencyMs",
  "pointerClass",
  "repeatedActionCount",
  "schemaVersion",
  "scrollDepthBps",
  "validationErrorCount",
  "visibilityLossCount",
].sort().join(",");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("NEXUS_VALIDATED_SHA must be an exact SHA-1");
  if (head !== expectedSha) throw new Error(`CORTEX #9 browser proof source mismatch: ${head} != ${expectedSha}`);
}

function startProbe(mode, artifactDigest = modelArtifactDigest) {
  // Own the actual Next.js server process. Launching through pnpm leaves the
  // package-manager wrapper as the child, which can hide server exit semantics
  // and made the exact-head browser proof unable to prove a clean restart.
  const child = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: probeRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXUS_CORTEX_08_MODE: "KILLED",
      NEXUS_CORTEX_09_MODE: mode,
      NEXUS_CORTEX_09_MODEL_JSON: modelJson,
      NEXUS_CORTEX_09_MODEL_ARTIFACT_DIGEST: artifactDigest,
      NEXUS_CORTEX_09_CALIBRATION_SOURCE_DIGEST: calibrationSourceDigest,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (error) => console.error("pipeline-probe child process error", error));
  return child;
}

function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

function signalProbeTree(processHandle, signal) {
  if (hasExited(processHandle)) return;
  if (process.platform !== "win32" && processHandle.pid) {
    try {
      process.kill(-processHandle.pid, signal);
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
  processHandle.kill(signal);
}

async function waitForProbeExit(processHandle, timeoutMs) {
  if (hasExited(processHandle)) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    processHandle.once("exit", onExit);
  });
}

async function stopProbe(processHandle) {
  if (!processHandle || hasExited(processHandle)) return;
  signalProbeTree(processHandle, "SIGTERM");
  if (await waitForProbeExit(processHandle, 10_000)) return;
  signalProbeTree(processHandle, "SIGKILL");
  if (await waitForProbeExit(processHandle, 2_000)) return;
  throw new Error("pipeline-probe did not stop after SIGTERM/SIGKILL");
}

async function readControl() {
  const response = await fetch(`${baseUrl}${controlPath}`, { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error(`CORTEX #9 control returned HTTP ${response.status}`);
  return response.json();
}

async function waitForControl(processHandle, expectedMode) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (hasExited(processHandle)) {
      throw new Error(`pipeline-probe exited before CORTEX #9 readiness with code ${processHandle.exitCode} signal ${processHandle.signalCode}`);
    }
    try {
      const body = await readControl();
      if (body?.mode === expectedMode) {
        if (body.featureContractId !== featureContractId) throw new Error("CORTEX #9 control feature contract mismatch");
        if (expectedMode === "ACTIVE" || expectedMode === "OBSERVE_ONLY") {
          if (body.modelId !== model.modelId || body.modelSourceDigest !== calibrationSourceDigest || body.modelArtifactDigest !== modelArtifactDigest) {
            throw new Error(`CORTEX #9 control model identity mismatch: ${JSON.stringify(body)}`);
          }
        } else if (!(body.modelId === null && body.modelSourceDigest === null && body.modelArtifactDigest === null)) {
          throw new Error(`CORTEX #9 KILLED control leaked model identity: ${JSON.stringify(body)}`);
        }
        return body;
      }
    } catch {
      // bounded readiness retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`pipeline-probe did not become ready in CORTEX #9 ${expectedMode} mode`);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  assertExactSource();
  execFileSync("pnpm", ["--filter", "@nexus/pipeline-probe", "build"], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXUS_VALIDATED_SHA: expectedSha },
    stdio: "inherit",
  });

  let server;
  let browser;
  let context;
  try {
    server = startProbe("ACTIVE", `sha256:${"f".repeat(64)}`);
    await waitForControl(server, "KILLED");
    await stopProbe(server);

    server = startProbe("ACTIVE");
    await waitForControl(server, "ACTIVE");

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "no-preference",
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    const scoreRequests = [];
    const scoreResponses = [];
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("request", (request) => {
      try {
        const url = new URL(request.url());
        if (url.origin === baseUrl && url.pathname === scorePath && request.method() === "POST") {
          const raw = request.postData();
          scoreRequests.push(raw ? JSON.parse(raw) : null);
        }
      } catch {
        scoreRequests.push(null);
      }
    });
    page.on("response", (response) => {
      try {
        const url = new URL(response.url());
        if (url.origin !== baseUrl || url.pathname !== scorePath || response.request().method() !== "POST") return;
        void response.json().then((body) => scoreResponses.push(body)).catch(() => scoreResponses.push(null));
      } catch {
        scoreResponses.push(null);
      }
    });

    const navigation = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 20_000 });
    if (!navigation?.ok()) throw new Error(`pipeline-probe root returned HTTP ${navigation?.status() ?? "unknown"}`);
    await page.waitForFunction(() => {
      const root = globalThis.document.documentElement;
      return typeof root.dataset.nexusCortex09Risk === "string" && typeof root.dataset.nexusCortex09Probability === "string";
    }, undefined, { timeout: 12_000 });

    await waitUntil(() => scoreRequests.length > 0 && scoreResponses.some((body) => body?.mode === "ACTIVE"), 5_000, "an ACTIVE CORTEX #9 scoring exchange");
    const activeRequest = scoreRequests.find((body) => body && Object.keys(body).sort().join(",") === snapshotKeys);
    if (!activeRequest) throw new Error(`CORTEX #9 browser did not send the exact minimized signal contract: ${JSON.stringify(scoreRequests)}`);
    if (activeRequest.featureContractId !== featureContractId || !(activeRequest.pointerClass === "COARSE" || activeRequest.pointerClass === "FINE")) {
      throw new Error(`CORTEX #9 browser sent invalid feature identity: ${JSON.stringify(activeRequest)}`);
    }
    const serializedRequest = JSON.stringify(activeRequest).toLowerCase();
    for (const forbidden of ["email", "phone", "name", "address", "value", "text", "href", "url", "gclid"]) {
      if (serializedRequest.includes(`"${forbidden}`)) throw new Error(`CORTEX #9 browser signal payload contains forbidden raw field ${forbidden}`);
    }

    const activeState = await page.evaluate(() => ({
      risk: globalThis.document.documentElement.dataset.nexusCortex09Risk ?? null,
      probability: globalThis.document.documentElement.dataset.nexusCortex09Probability ?? null,
    }));
    if (!(activeState.risk === "LOW" || activeState.risk === "MEDIUM" || activeState.risk === "HIGH")) throw new Error(`invalid ACTIVE risk state ${JSON.stringify(activeState)}`);
    const activeProbability = Number(activeState.probability);
    if (!Number.isFinite(activeProbability) || activeProbability < 0 || activeProbability > 1) throw new Error(`invalid ACTIVE probability state ${JSON.stringify(activeState)}`);

    await stopProbe(server);
    server = startProbe("OBSERVE_ONLY");
    await waitForControl(server, "OBSERVE_ONLY");
    const responseCountBeforeObserve = scoreResponses.length;
    await waitUntil(
      () => scoreResponses.slice(responseCountBeforeObserve).some((body) => body?.mode === "OBSERVE_ONLY" && body?.score === null && body?.modelArtifactDigest === modelArtifactDigest),
      12_000,
      "an OBSERVE_ONLY CORTEX #9 scoring exchange",
    );
    await page.waitForFunction(() => {
      const root = globalThis.document.documentElement;
      return root.dataset.nexusCortex09Risk === undefined && root.dataset.nexusCortex09Probability === undefined;
    }, undefined, { timeout: 5_000 });

    await stopProbe(server);
    server = startProbe("KILLED");
    await waitForControl(server, "KILLED");
    await page.waitForFunction(() => {
      const root = globalThis.document.documentElement;
      return root.dataset.nexusCortex09Risk === undefined && root.dataset.nexusCortex09Probability === undefined;
    }, undefined, { timeout: 8_000 });

    if (pageErrors.length) throw new Error(`CORTEX #9 browser page errors: ${JSON.stringify(pageErrors)}`);
    process.stdout.write(`${JSON.stringify({
      component: "cortex-09-browser-proof",
      sourceRevision: expectedSha,
      featureContractId,
      modelId: model.modelId,
      modelSourceDigest: calibrationSourceDigest,
      modelArtifactDigest,
      verdict: "PASS",
    })}\n`);
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await stopProbe(server).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
