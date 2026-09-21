// Verify executed test identities, not just a zero exit status or TAP-looking text.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const reporter = fileURLToPath(new URL('./test-event-reporter.mjs', import.meta.url));
const MAX_OUTPUT = 256 * 1024;
const fail = (message) => { throw new Error(message); };

function identity(test, root) {
  if (typeof test.file !== 'string' || !path.isAbsolute(test.file)) fail('Unattributed test event');
  const relative = path.relative(root, test.file).split(path.sep).join('/');
  if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) fail('Test event escaped checkout');
  if (typeof test.name !== 'string' || !test.name || !Number.isInteger(test.line) ||
      !Number.isInteger(test.column) || !Number.isInteger(test.nesting)) fail('Malformed test event');
  // A worker that exits early may be reported as one PASS named after the file.
  if (test.name === test.file || test.name === relative) fail('Test file exited without executing named assertions');
  return JSON.stringify([relative, test.name, test.line, test.column, test.nesting]);
}

export async function runTestEvidence(root, files, baseline = null) {
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length ||
      files.some((file) => typeof file !== 'string' || !/^gauss\/tests\/[\w./-]+\.test\.mjs$/.test(file) ||
        file.split('/').some((p) => p === '.' || p === '..' || !p))) fail('Explicit GAUSS test paths required');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', `--test-reporter=${reporter}`, ...files], {
      cwd: root, shell: false,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), killed = false, done = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 90_000);
    const append = (which, chunk) => {
      if (which === 'out') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > MAX_OUTPUT) { killed = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (b) => append('out', b));
    child.stderr.on('data', (b) => append('err', b));
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killed) reject(new Error('Test execution exceeded time/output budget'));
      else resolve({ code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { fail(`Missing trusted test receipt: ${result.stderr.slice(-1000)}`); }
  if (receipt?.schemaVersion !== 1 || !Array.isArray(receipt.tests) ||
      !Number.isInteger(receipt.plan) || receipt.plan !== receipt.tests.length || !receipt.tests.length) {
    fail('Incomplete Node test execution receipt');
  }
  const names = receipt.tests.map((test) => identity(test, root));
  if (new Set(names).size !== names.length) fail('Duplicate executed test identity');
  if (receipt.tests.some((test) => test.skipped || test.todo)) fail('Skipped or TODO assertions are not valid repair evidence');
  const actualFiles = new Set(receipt.tests.map((test) => path.relative(root, test.file).split(path.sep).join('/')));
  if (files.some((file) => !actualFiles.has(file))) fail('A declared test file did not execute assertions');
  if (baseline && (names.length !== baseline.length || names.some((name, i) => name !== baseline[i]))) {
    fail('Repair changed the executed test identities');
  }
  const failures = receipt.tests.filter((test) => !test.passed).length;
  if ((result.code === 0 && failures !== 0) || (result.code !== 0 && failures === 0) || result.signal) {
    fail('Test exit status contradicts executed test evidence');
  }
  return { code: result.code, signal: result.signal,
    stdout: receipt.diagnostics ?? '', stderr: result.stderr, identities: names,
    count: names.length, failures };
}
