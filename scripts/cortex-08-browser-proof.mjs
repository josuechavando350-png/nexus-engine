#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromCapture = createRequire(join(repositoryRoot, "packages", "capture", "package.json"));
const { chromium } = requireFromCapture("playwright");
const port = 39181;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedSha = process.env.NEXUS_VALIDATED_SHA?.trim();

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
  return spawn("pnpm", ["--filter", "@nexus/pipeline-probe", "exec", "next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NEXUS_CORTEX_08_MODE: mode,
      NEXUS_CORTEX_08_MAX_PREPARED_TARGETS: "2",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    const proofLink = page.locator('a[href="/proof"]').first();
    if ((await proofLink.count()) !== 1) throw new Error("real probe consumer is missing the /proof navigation target");
    await proofLink.hover();
    await page.waitForFunction(() => document.querySelectorAll('[data-nexus-cortex08="1"]').length === 1, undefined, { timeout: 5_000 });

    const prepared = await page.evaluate(() => Array.from(document.querySelectorAll('[data-nexus-cortex08="1"]')).map((node) => ({
      tag: node.tagName,
      href: node instanceof HTMLLinkElement ? node.href : null,
      type: node instanceof HTMLScriptElement ? node.type : null,
      text: node instanceof HTMLScriptElement ? node.textContent : null,
    })));
    if (prepared.length !== 1) throw new Error(`expected one CORTEX-owned speculative node, observed ${prepared.length}`);
    const serialized = JSON.stringify(prepared[0]);
    if (!serialized.includes("/proof")) throw new Error("speculative side effect is not bound to the real /proof target");
    if (serialized.includes("cano-penal") || serialized.includes("canopenal.com")) throw new Error("CORTEX #8 browser proof must not target the client site");

    const external = page.locator('a[href^="https://wa.me/"]').first();
    if ((await external.count()) === 1) {
      await external.hover();
      await page.waitForTimeout(100);
      const count = await page.locator('[data-nexus-cortex08="1"]').count();
      if (count !== 1) throw new Error("cross-origin hover created a speculative side effect");
    }

    await stopProbe(server);
    server = startProbe("KILLED");
    await waitForServer(server, "KILLED");
    await page.waitForFunction(() => document.querySelectorAll('[data-nexus-cortex08="1"]').length === 0, undefined, { timeout: 8_000 });
    const killedControl = await page.evaluate(async () => {
      const response = await fetch("/api/cortex/prerender/control", { cache: "no-store" });
      return response.json();
    });
    if (killedControl?.mode !== "KILLED") throw new Error("browser did not observe KILLED control after server restart");

    process.stdout.write(`${JSON.stringify({ component: "cortex-08-browser-proof", sourceRevision: expectedSha, verdict: "PASS" })}\n`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopProbe(server).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
