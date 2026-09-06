#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCapture = createRequire(join(repositoryRoot, "packages", "capture", "package.json"));
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
    if (processHandle.exitCode !== null) throw new Error(`pipeline-probe exited before readiness with code ${processHandle.exitCode}`);
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
  const child = spawn("pnpm", ["--filter", "@nexus/pipeline-probe", "exec", "next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NEXUS_CORTEX_08_MODE: mode,
      NEXUS_CORTEX_08_MAX_PREPARED_TARGETS: "2",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (error) => console.error("pipeline-probe child process error", error));
  return child;
}

async function stopProbe(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (processHandle.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processHandle.exitCode === null) {
    processHandle.kill("SIGKILL");
    throw new Error("pipeline-probe did not stop after SIGTERM");
  }
}

async function assertRootServed(processHandle) {
  const response = await fetch(baseUrl, { redirect: "error", headers: { accept: "text/html" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`pipeline-probe root readiness returned HTTP ${response.status}`);
  if (processHandle.exitCode !== null) throw new Error(`pipeline-probe exited while serving root with code ${processHandle.exitCode}`);
  if (!body.includes("<a") || ![...allowedProbeRoutes].some((path) => body.includes(`href="${path}"`))) {
    throw new Error(`pipeline-probe root HTML lacks a real allowlisted navigation target; bytes=${Buffer.byteLength(body)}`);
  }
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
  try {
    await waitForServer(server, "ACTIVE");
    await assertRootServed(server);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const navigation = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (!navigation?.ok()) throw new Error(`pipeline-probe root returned HTTP ${navigation?.status() ?? "unknown"}`);
    if (server.exitCode !== null) throw new Error(`pipeline-probe exited after browser navigation with code ${server.exitCode}`);

    try {
      await page.locator('a[href]').first().waitFor({ state: "attached", timeout: 10_000 });
    } catch {
      const bodyText = (await page.locator("body").innerText().catch(() => "")).slice(0, 1000);
      const htmlBytes = Buffer.byteLength(await page.content().catch(() => ""));
      throw new Error(`real probe rendered no anchors; url=${page.url()} htmlBytes=${htmlBytes} pageErrors=${JSON.stringify(pageErrors)} body=${JSON.stringify(bodyText)}`);
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
    if (browser) await browser.close().catch(() => undefined);
    await stopProbe(server).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
