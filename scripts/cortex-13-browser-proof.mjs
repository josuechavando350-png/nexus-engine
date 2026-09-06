#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probeRoot = join(repositoryRoot, "apps", "pipeline-probe");
const requireFromCapture = createRequire(join(repositoryRoot, "packages", "capture", "package.json"));
const requireFromProbe = createRequire(join(probeRoot, "package.json"));
const nextCli = requireFromProbe.resolve("next/dist/bin/next");
const { chromium } = requireFromCapture("playwright");
const port = 39183;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const controlPath = "/api/cortex/cwv/control";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("NEXUS_VALIDATED_SHA must be an exact SHA-1");
  if (head !== expectedSha) throw new Error(`CORTEX #13 browser proof source mismatch: ${head} != ${expectedSha}`);
}

function startProbe(mode) {
  const child = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: probeRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXUS_CORTEX_08_MODE: "ACTIVE",
      NEXUS_CORTEX_09_MODE: "KILLED",
      NEXUS_CORTEX_13_MODE: mode,
      NEXUS_CORTEX_13_LCP_PRESSURE_MS: "60000",
      NEXUS_CORTEX_13_CLS_PRESSURE: "10",
      NEXUS_CORTEX_13_INP_PRESSURE_MS: "10000",
      NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS: "50",
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
  if (!response.ok) throw new Error(`CORTEX #13 control returned HTTP ${response.status}`);
  return response.json();
}

async function waitForControl(processHandle, expectedMode) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (hasExited(processHandle)) throw new Error(`pipeline-probe exited before CORTEX #13 readiness with code ${processHandle.exitCode} signal ${processHandle.signalCode}`);
    try {
      const body = await readControl();
      if (body?.mode === expectedMode) {
        if (expectedMode === "KILLED") {
          if (body.thresholds !== null) throw new Error(`CORTEX #13 KILLED control leaked thresholds: ${JSON.stringify(body)}`);
        } else if (body.thresholds?.longTaskPressureMs !== 50) {
          throw new Error(`CORTEX #13 threshold identity mismatch: ${JSON.stringify(body)}`);
        }
        return body;
      }
    } catch {
      // bounded readiness retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`pipeline-probe did not become ready in CORTEX #13 ${expectedMode} mode`);
}

async function waitUntil(predicate, timeoutMs, label, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = diagnostics ? ` diagnostics=${JSON.stringify(await diagnostics())}` : "";
  throw new Error(`timed out waiting for ${label}${detail}`);
}

async function findInternalTarget(page) {
  const targets = await page.evaluate(() => [...globalThis.document.querySelectorAll("header nav a[href]")].map((anchor) => ({
    href: anchor.getAttribute("href"),
    absolute: typeof anchor.href === "string" ? anchor.href : null,
  })));
  for (const target of targets) {
    if (!target.absolute) continue;
    const url = new URL(target.absolute);
    if (url.origin === baseUrl && ["/explore", "/proof", "/visit", "/contact"].includes(url.pathname)) return target.href;
  }
  throw new Error(`CORTEX #13 proof could not find a real allowlisted internal navigation target: ${JSON.stringify(targets)}`);
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
    server = startProbe("ACTIVE");
    await waitForControl(server, "ACTIVE");

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference", locale: "en-US", timezoneId: "UTC" });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

    const navigation = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 20_000 });
    if (!navigation?.ok()) throw new Error(`pipeline-probe root returned HTTP ${navigation?.status() ?? "unknown"}`);

    const diagnostics = async () => page.evaluate(() => ({
      state: globalThis.document.documentElement.dataset.nexusCortex13State ?? null,
      reasons: globalThis.document.documentElement.dataset.nexusCortex13Reasons ?? null,
      suspended: globalThis.document.documentElement.dataset.nexusCortex13SuspendSpeculation ?? null,
      speculativeNodes: globalThis.document.querySelectorAll('[data-nexus-cortex08="1"]').length,
      performanceEntryTypes: globalThis.PerformanceObserver?.supportedEntryTypes ?? [],
    }));

    await waitUntil(async () => (await diagnostics()).state === "NORMAL", 8_000, "CORTEX #13 NORMAL lifecycle state", diagnostics);
    const target = await findInternalTarget(page);
    await page.hover(`a[href="${target}"]`);
    await waitUntil(async () => (await diagnostics()).speculativeNodes === 1, 8_000, "CORTEX #8 speculative node before CWV pressure", diagnostics);

    // Let the production client leave its navigation/bootstrap warm-up window,
    // then produce a real main-thread scheduling stall. The product observes
    // either the Long Tasks API or its independent event-loop lateness fallback;
    // the proof does not inject CORTEX state or call internal implementation hooks.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await page.evaluate(() => {
      const start = performance.now();
      while (performance.now() - start < 180) {
        Math.sqrt(12345.6789);
      }
    });

    await waitUntil(async () => {
      const state = await diagnostics();
      return state.state === "PRESSURE" && state.suspended === "1" && state.speculativeNodes === 0 && String(state.reasons).includes("LONG_TASK");
    }, 8_000, "real main-thread pressure to suspend and roll back speculation", diagnostics);

    await page.hover(`a[href="${target}"]`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if ((await diagnostics()).speculativeNodes !== 0) throw new Error(`CORTEX #13 pressure allowed speculative work to reappear: ${JSON.stringify(await diagnostics())}`);

    await stopProbe(server);
    server = startProbe("OBSERVE_ONLY");
    await waitForControl(server, "OBSERVE_ONLY");
    await waitUntil(async () => {
      const state = await diagnostics();
      return state.state === null && state.suspended === null;
    }, 8_000, "OBSERVE_ONLY rollback of consumer-visible optimizer state", diagnostics);

    // OBSERVE_ONLY must not block CORTEX #8. The suspension transition also
    // clears CORTEX #8's internal prepared-target budget before this hover.
    await page.hover(`a[href="${target}"]`);
    await waitUntil(async () => (await diagnostics()).speculativeNodes === 1, 8_000, "speculation after OBSERVE_ONLY rollback", diagnostics);

    await stopProbe(server);
    server = startProbe("KILLED");
    await waitForControl(server, "KILLED");
    await waitUntil(async () => {
      const state = await diagnostics();
      return state.state === null && state.suspended === null;
    }, 8_000, "KILLED optimizer rollback", diagnostics);

    if (pageErrors.length || consoleErrors.length) throw new Error(`CORTEX #13 browser errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
    process.stdout.write(`${JSON.stringify({ component: "cortex-13-browser-proof", sourceRevision: expectedSha, signal: "real-main-thread-scheduling-stall", integration: "cortex08-speculation-suspension", verdict: "PASS" })}\n`);
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
