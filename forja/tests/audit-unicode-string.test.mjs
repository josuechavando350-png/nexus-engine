import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditNexus } from '../audit.mjs';

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'forja-unicode-static-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({
    schemaVersion: 1,
    roots: ['core'],
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

for (const separator of ['\u2028', '\u2029']) {
  test(`Unicode separator U+${separator.codePointAt(0).toString(16)} inside a JS string is not a static import`, async (t) => {
    // ECMAScript permits U+2028/U+2029 in a quoted string. A regex in /m mode
    // still treats them as line boundaries; they must not create code tokens.
    const source = `const literal = "before${separator}import './worker.mjs';${separator}after";\nexport const value = 1;\n`;
    const root = await fixture(t, source);
    const report = await auditNexus({ root });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.checked.evidencedLinks, 0);
    assert.ok(report.findings.some(({ code }) => code === 'DECLARED_LINK_NOT_FOUND'));
  });
}

test('a real static import following a Unicode-containing literal is still evidenced', async (t) => {
  const source = `const literal = "before\u2028import './worker.mjs';\u2028after";\nimport './worker.mjs';\n`;
  const report = await auditNexus({ root: await fixture(t, source) });
  assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
  assert.equal(report.checked.evidencedLinks, 1);
});

for (const separator of ['\u2028', '\u2029']) {
  test(`real static import after a U+${separator.codePointAt(0).toString(16)} line-comment boundary is evidenced`, async (t) => {
    const source = `// comment ends at Unicode line separator${separator}import './worker.mjs';\n`;
    const root = await fixture(t, source);
    const report = await auditNexus({ root });
    assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
    assert.equal(report.checked.evidencedLinks, 1);
  });
}
