#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../packages/capture/package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.match(sha, /^[a-f0-9]{40}$/);
assert.equal(sha, process.env.NEXUS_VALIDATED_SHA, 'The browser proof must run against the exact checked-out PR SHA');

const port = 33371;
const url = `http://127.0.0.1:${port}/`;
const expectedWhatsApp = 'https://wa.me/5215560501901';
const output = join(root, 'artifacts', 'browser-capture', 'cano-contact-proof');
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

async function waitForServer(child) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CANO site exited before becoming ready: ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  }
  throw new Error('CANO production build did not respond within 90 seconds');
}

await mkdir(output, { recursive: true });
const server = spawn('pnpm', ['--filter', '@nexus/cano-penal', 'exec', 'next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: root,
  env: process.env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => { serverLog = (serverLog + chunk.toString()).slice(-12000); });
}
const evidence = [];
try {
  await waitForServer(server);
  for (const [browserName, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await browserType.launch({ headless: true });
    try {
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        try {
          // An external WhatsApp request is intercepted: no actual message is sent.
          await context.route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'WhatsApp destination intercepted for browser proof' }));
          const page = await context.newPage();
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          assert.equal(response?.status(), 200, `${browserName}/${viewport.name} must serve the homepage`);
          assert.equal(await page.locator('main#main-content').count(), 1, 'Skip-link destination must remain present');
          assert.ok(await page.locator('h1').first().isVisible(), 'Hero heading must be visible');
          const hero = page.locator('.cp-actions a.cp-btn-solid');
          assert.equal(await hero.count(), 1, 'Exactly one primary hero contact link must exist');
          assert.equal(await hero.getAttribute('href'), expectedWhatsApp, 'Hero must open CANO WhatsApp directly');
          assert.equal(await hero.getAttribute('target'), '_blank');
          const contact = page.locator('.cp-contact-section a.cp-contact-action');
          assert.equal(await contact.count(), 1, 'Contact section must retain a direct WhatsApp link');
          assert.equal(await contact.getAttribute('href'), expectedWhatsApp);
          assert.equal(await page.locator('.cp-contact-section form, .cp-contact-section input, .cp-contact-section textarea').count(), 0,
            'Contact section must not present fields without a working submission');
          const popupPromise = page.waitForEvent('popup', { timeout: 10000 });
          await hero.click();
          const popup = await popupPromise;
          await popup.waitForLoadState('domcontentloaded');
          assert.equal(new URL(popup.url()).hostname, 'wa.me', 'Click must open the intended WhatsApp host');
          await popup.close();
          const png = await page.screenshot({ fullPage: true });
          const name = `${browserName}-${viewport.name}.png`;
          await writeFile(join(output, name), png);
          evidence.push({ browser: browserName, viewport: viewport.name, screenshot: name,
            sha256: createHash('sha256').update(png).digest('hex'), bytes: png.byteLength });
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  assert.equal(evidence.length, 4);
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ sourceRevision: sha, project: 'cano-penal', checks: evidence }, null, 2)}\n`);
  console.log(`CANO contact proof PASS: ${sha}, 2 browsers x 2 viewports, direct WhatsApp CTA, no dead form`);
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already exited */ }
}
