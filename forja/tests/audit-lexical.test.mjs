import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditNexus } from '../audit.mjs';

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'forja-lexical-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({
    schemaVersion: 1, roots: ['core'],
    nodes: [
      { id: 'core', path: 'src/core.mjs', kind: 'esm' },
      { id: 'worker', path: 'src/worker.mjs', kind: 'esm' },
    ],
    links: [{ from: 'core', to: 'worker', method: 'esm-static-import' }],
  }));
  await writeFile(join(root, 'src/core.mjs'), source);
  await writeFile(join(root, 'src/worker.mjs'), 'export const worker = 1;\n');
  return root;
}

test('multiline block comment cannot masquerade as imported module', async (t) => {
  const root = await fixture(t, "/*\nimport './worker.mjs';\n*/\nexport const value = 1;\n");
  const report = await auditNexus({ root });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.checked.evidencedLinks, 0);
  assert.ok(report.findings.some((finding) => finding.code === 'DECLARED_LINK_NOT_FOUND'));
});

test('real multiline template and interpolation cannot masquerade as an import', async (t) => {
  const source = ['const example = `text', "import './worker.mjs';", '${1 + 1}`;'].join('\n') + '\n';
  assert.match(source, /\nimport /);
  const root = await fixture(t, source);
  const report = await auditNexus({ root });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.checked.evidencedLinks, 0);
});

test('real ESM import remains visible after ordinary quotes and trailing comments', async (t) => {
  const root = await fixture(t, "const url = 'https://example.invalid/x';\nimport './worker.mjs'; // real link\n");
  const report = await auditNexus({ root });
  assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
  assert.equal(report.checked.evidencedLinks, 1);
});
