import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditNexus } from '../audit.mjs';

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'forja-export-syntax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({
    schemaVersion: 1, roots: ['core'], nodes: [
      { id: 'core', path: 'src/core.mjs', kind: 'esm' },
      { id: 'worker', path: 'src/worker.mjs', kind: 'esm' },
    ], links: [{ from: 'core', to: 'worker', method: 'esm-static-import' }],
  }));
  const core = join(root, 'src/core.mjs');
  await writeFile(core, source);
  await writeFile(join(root, 'src/worker.mjs'), 'export const value = 1;\n');
  return { root, core };
}

for (const [description, source] of [
  ['bare export string', "export './worker.mjs';\n"],
  ['unsupported export default-from syntax', "export value from './worker.mjs';\n"],
]) {
  test(`invalid ${description} cannot prove a static link`, async (t) => {
    const { root, core } = await fixture(t, source);
    const syntax = spawnSync(process.execPath, ['--check', core], { encoding: 'utf8' });
    assert.notEqual(syntax.status, 0, 'control must be syntactically invalid ESM');
    const report = await auditNexus({ root });
    assert.equal(report.status, 'FAIL', JSON.stringify(report.findings));
    assert.equal(report.checked.evidencedLinks, 0);
    assert.ok(report.findings.some(({ code }) => code === 'DECLARED_LINK_NOT_FOUND'));
  });
}

for (const [description, source] of [
  ['side-effect import', "import './worker.mjs';\n"],
  ['named re-export', "export { value } from './worker.mjs';\n"],
  ['star re-export', "export * from './worker.mjs';\n"],
  ['namespace re-export', "export * as ns from './worker.mjs';\n"],
]) {
  test(`valid ${description} remains evidenced`, async (t) => {
    const { root, core } = await fixture(t, source);
    const syntax = spawnSync(process.execPath, ['--check', core], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const report = await auditNexus({ root });
    assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
    assert.equal(report.checked.evidencedLinks, 1);
  });
}
