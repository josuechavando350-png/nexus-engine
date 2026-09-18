// Keep the audited 200-task fixture immutable; assemble the connected extension explicitly.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildGaussFoundationFixture() {
  const [baseline, extension] = await Promise.all([
    readFile(new URL('../fixtures/selftest-problem.json', import.meta.url), 'utf8'),
    readFile(new URL('../fixtures/selftest-201-202-tasks.json', import.meta.url), 'utf8'),
  ]).then(bytes => bytes.map(JSON.parse));
  if (!Array.isArray(baseline.tasks) || baseline.tasks.length !== 200
      || !Array.isArray(extension.tasks) || extension.tasks.length !== 2
      || Object.keys(extension).length !== 1) {
    throw new Error('GAUSS foundation fixture baseline/extension identity mismatch');
  }
  const tasks = [...baseline.tasks, ...extension.tasks];
  if (new Set(tasks.map(item => item.taskId)).size !== tasks.length
      || new Set(tasks.map(item => item.layerId)).size !== tasks.length) {
    throw new Error('GAUSS foundation fixture task and layer IDs must be one-to-one');
  }
  return { ...baseline,
    objective: 'Exercise all 202 implemented GAUSS scientific operators with deterministic evidence and independently verified replay.',
    tasks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') {
    throw new Error('Usage: node gauss/core/foundation-fixture.mjs --out <new-json-path>');
  }
  const fixture = await buildGaussFoundationFixture();
  await writeFile(process.argv[3], `${JSON.stringify(fixture, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`GAUSS_FOUNDATION_FIXTURE_TASKS=${fixture.tasks.length}`);
}
