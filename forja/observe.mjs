#!/usr/bin/env node
// Local, authenticated, read-only status endpoint. Not a deployed service or a TLS server.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectJob } from './state-inspector.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function demand(ok, text) { if (!ok) throw new Error(`FORJA_OBSERVER: ${text}`); }
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !given.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(given.slice(7), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
function reply(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'" });
  res.end(`${JSON.stringify(value)}\n`);
}
export function createObserver({ root, stateDir, token }) {
  demand(typeof root === 'string' && isAbsolute(root) && typeof stateDir === 'string' && isAbsolute(stateDir), 'absolute paths required');
  demand(typeof token === 'string' && Buffer.byteLength(token) >= 32 && Buffer.byteLength(token) <= 256 && !/[\r\n]/.test(token), 'token must be 32-256 bytes');
  let busy = 0;
  const server = createServer(async (req, res) => {
    if (!tokenMatches(req.headers.authorization, token)) { reply(res, 401, { error: 'unauthorized' }); return; }
    if (req.method !== 'GET') { reply(res, 405, { error: 'read-only' }); return; }
    if (++busy > 8) { busy--; reply(res, 503, { error: 'busy' }); return; }
    try {
      const route = req.url;
      if (route === '/v1/health') { reply(res, 200, { status: 'UP', scope: 'local-observer-only' }); return; }
      if (route === '/v1/jobs') {
        const state = await realpath(stateDir);
        const files = (await readdir(join(state, 'jobs'))).filter((file) => file.endsWith('.json')).sort();
        demand(files.length <= 1000, 'job list exceeds bounded response');
        const jobs = [];
        for (const file of files) {
          demand(ID.test(file.slice(0, -5)), 'unexpected job filename');
          const path = join(state, 'jobs', file), st = await lstat(path);
          demand(st.isFile() && !st.isSymbolicLink() && st.size >= 2 && st.size <= 2 * 1024 * 1024, 'unsafe job file');
          const data = JSON.parse(await readFile(path, 'utf8'));
          demand(data.id === file.slice(0, -5) && typeof data.status === 'string', 'invalid job list record');
          jobs.push({ id: data.id, status: data.status, sourceRevision: data.sourceRevision });
        }
        reply(res, 200, { schemaVersion: 1, jobs }); return;
      }
      const match = /^\/v1\/jobs\/([0-9a-f-]{36})$/.exec(route ?? '');
      if (match && ID.test(match[1])) {
        const result = await inspectJob({ root, stateDir, id: match[1] });
        reply(res, 200, result); return;
      }
      reply(res, 404, { error: 'not found' });
    } catch (error) {
      if (process.env.CI === 'true') console.error('FORJA_OBSERVER_CI_DIAGNOSTIC', error?.message);
      // No filesystem paths, stack traces, or evidence contents cross the HTTP boundary.
      reply(res, 503, { error: 'state unavailable or evidence invalid' });
    } finally { busy--; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  return server;
}
export async function startObserver({ port = 8765, ...options }) {
  demand(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'invalid port');
  const server = createObserver(options);
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); });
    });
    return server;
  } catch (error) { server.close(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, stateDir, portText, ...rest] = process.argv.slice(2);
    demand(!rest.length && root && stateDir && (!portText || /^\d+$/.test(portText)),
      'usage: FORJA_STATUS_TOKEN=... node forja/observe.mjs /abs/repo /abs/state [port]');
    const server = await startObserver({ root, stateDir, token: process.env.FORJA_STATUS_TOKEN, port: portText ? Number(portText) : 8765 });
    process.stdout.write(`${JSON.stringify({ status: 'LISTENING', bind: '127.0.0.1', port: server.address().port })}\n`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  } catch (error) {
    console.error(String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500));
    process.exitCode = 2;
  }
}
