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
const port = 39181;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();
const allowedProbeRoutes = new Set(["/explore", "/proof", "/visit", "/contact"]);

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertExactSource() {
  const head = git(["rev-parse", "HEAD"]);
  if (!expectedSha || !/^[a-f0-9]{40}$/u.test(expectedSha)) throw new Error("NEXUS_VALIDATED_SHA must be an exact SHA-1");
  if (head !== expectedSha) throw new Error(`CORTEX #8 browser proof source mismatch: ${head} != ${expectedSha}`);
}

async function waitForServer(processHandle, expectedMode) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
      throw new Error(`pipeline-probe exited before readiness with code ${processHandle.exitCode} signal ${processHandle.signalCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/cortex/prerender/control`, { headers: { accept: "application/json" }, redirect: "error" });
      if (response.ok) {
        const body = await response.json();
        if (body?.mode !== expectedMode) throw new Error(`unexpected control mode ${String(body?.mode)}`);
        return;
      }
    } catch {
      // bounded readiness retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`pipeline-probe did not become ready in ${expectedMode} mode`);
}

function startProbe(mode) {
  // Launch Next directly rather than through pnpm. The proof must own the actual
  // server process so SIGTERM semantics are observable instead of being hidden
  // behind a package-manager wrapper process.
  const child = spawn(process.execPath, [nextCli, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: probeRoot,
    env: {
      ...process.env,
      NEXUS_CORTEX_08_MODE: mode,
      NEXUS_CORTEX_08_MAX_PREPARED_TARGETS: "2",
      NODE_ENV: "production",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (error) => console.error("pipeline-probe child process error", error));
  return child;
}

function signalProbeTree(processHandle, signal) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
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
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true;
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
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  signalProbeTree(processHandle, "SIGTERM");
  if (await waitForProbeExit(processHandle, 10_000)) return;
  signalProbeTree(processHandle, "SIGKILL");
  await waitForProbeExit(processHandle, 2_000);
  throw new Error("pipeline-probe did not stop after SIGTERM");
}

async function assertRootServed(processHandle) {
  const response = await fetch(baseUrl, { redirect: "error", headers: { accept: "text/html" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`pipeline-probe root readiness returned HTTP ${response.status}`);
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(`pipeline-probe exited while serving root with code ${processHandle.exitCode} signal ${processHandle.signalCode}`);
  }
  if (!body.includes("<a") || ![...allowedProbeRoutes].some((path) => body.includes(`href="${path}"`))) {
    throw new Error(`pipeline-probe root HTML lacks a real allowlisted navigation target; bytes=${Buffer.byteLength(body)}`);
  }
}

async function openProbePage() {
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "no-preference",
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    const pageErrors = [];
    let crashed = false;
    let closed = false;
    let disconnected = false;
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("crash", () => { crashed = true; });
    page.on("close", () => { closed = true; });
    browser.on("disconnected", () => { disconnected = true; });
    try {
      const navigation = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 20_000 });
      if (!navigation?.ok()) throw new Error(`root returned HTTP ${navigation?.status() ?? "unknown"}`);
      await page.locator('a[href]').first().waitFor({ state: "attached", timeout: 10_000 });
      return { browser, context, page, pageErrors };
    } catch (error) {
      const url = page.isClosed() ? "closed" : page.url();
      const htmlBytes = page.isClosed() ? 0 : Buffer.byteLength(await page.content().catch(() => ""));
      failures.push({ attempt, error: String(error), url, htmlBytes, crashed, closed, disconnected, pageErrors });
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`real probe browser could not reach a rendered navigation target: ${JSON.stringify(failures)}`);
}

async function main() {
  assertExactSource();
  execFileSync("pnpm", ["--filter", "@nexus/pipeline-probe", "build"], {
    cwd: repositoryRoot,
    env: { ...process.env, NEXUS_VALIDATED_SHA: expectedSha },
    stdio: "inherit",
  });

  let server = startProbe("ACTIVE");
  let browser;
  let context;
  try {
    await waitForServer(server, "ACTIVE");
    await assertRootServed(server);

    const opened = await openProbePage();
    browser = opened.browser;
    context = opened.context;
    const { page, pageErrors } = opened;
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`pipeline-probe exited after browser navigation with code ${server.exitCode} signal ${server.signalCode}`);
    }

    const renderedAnchors = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => ({
      href: anchor.getAttribute("href"),
      resolvedHref: anchor instanceof globalThis.HTMLAnchorElement ? anchor.href : null,
    })));
    const realTarget = renderedAnchors
      .map((anchor, index) => {
        try {
          const url = new URL(anchor.resolvedHref ?? "", baseUrl);
          return { ...anchor, index, origin: url.origin, pathname: url.pathname };
        } catch {
          return null;
        }
      })
      .find((anchor) => anchor && anchor.origin === baseUrl && allowedProbeRoutes.has(anchor.pathname));
    if (!realTarget) throw new Error(`real probe consumer has no rendered allowlisted route target: ${JSON.stringify(renderedAnchors)} pageErrors=${JSON.stringify(pageErrors)}`);

    const routeLink = page.locator("a[href]").nth(realTarget.index);
    await routeLink.hover();
    await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-nexus-cortex08="1"]').length === 1, undefined, { timeout: 5_000 });

    const prepared = await page.evaluate(() => Array.from(globalThis.document.querySelectorAll('[data-nexus-cortex08="1"]')).map((node) => ({
      tag: node.tagName,
      href: node instanceof globalThis.HTMLLinkElement ? node.href : null,
      type: node instanceof globalThis.HTMLScriptElement ? node.type : null,
      text: node instanceof globalThis.HTMLScriptElement ? node.textContent : null,
    })));
    if (prepared.length !== 1) throw new Error(`expected one CORTEX-owned speculative node, observed ${prepared.length}`);
    const serialized = JSON.stringify(prepared[0]);
    if (!serialized.includes(realTarget.pathname)) throw new Error(`speculative side effect is not bound to rendered probe target ${realTarget.pathname}`);
    if (serialized.includes("cano-penal") || serialized.includes("canopenal.com")) throw new Error("CORTEX #8 browser proof must not target the client site");

    await page.evaluate(() => {
      const testLink = globalThis.document.createElement("a");
      testLink.href = "https://example.invalid/cortex-cross-origin";
      testLink.textContent = "cross origin browser proof";
      testLink.dataset.cortexCrossOriginProof = "1";
      globalThis.document.body.appendChild(testLink);
    });
    await page.locator('[data-cortex-cross-origin-proof="1"]').hover();
    await page.waitForTimeout(100);
    const afterCrossOrigin = await page.locator('[data-nexus-cortex08="1"]').count();
    if (afterCrossOrigin !== 1) throw new Error("cross-origin hover created a speculative side effect");

    await stopProbe(server);
    server = startProbe("KILLED");
    await waitForServer(server, "KILLED");
    await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-nexus-cortex08="1"]').length === 0, undefined, { timeout: 8_000 });
    const killedControl = await page.evaluate(async () => {
      const response = await fetch("/api/cortex/prerender/control", { cache: "no-store" });
      return response.json();
    });
    if (killedControl?.mode !== "KILLED") throw new Error("browser did not observe KILLED control after server restart");

    process.stdout.write(`${JSON.stringify({ component: "cortex-08-browser-proof", sourceRevision: expectedSha, targetPath: realTarget.pathname, verdict: "PASS" })}\n`);
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
