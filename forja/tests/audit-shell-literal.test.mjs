import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditNexus } from '../audit.mjs';

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'forja-shell-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({
    schemaVersion: 1, roots: ['entry'], nodes: [
      { id: 'entry', path: 'entry.sh', kind: 'shell' },
      { id: 'core', path: 'src/core.mjs', kind: 'esm' },
    ], links: [{ from: 'entry', to: 'core', method: 'shell-node-exec' }],
  }));
  await writeFile(join(root, 'entry.sh'), source);
  await writeFile(join(root, 'src/core.mjs'), 'export const value = 1;\n');
  return root;
}

for (const [name, source] of [
  ['quoted heredoc', "#!/bin/sh\ncat <<'EXAMPLE'\nnode src/core.mjs\nEXAMPLE\n"],
  ['unquoted heredoc', '#!/bin/sh\ncat <<EXAMPLE\nnode src/core.mjs\nEXAMPLE\n'],
  ['multiline single-quoted literal', "#!/bin/sh\nprintf '%s' 'not executed\nnode src/core.mjs\n'\n"],
  ['multiline double-quoted literal', '#!/bin/sh\nprintf "%s" "not executed\nnode src/core.mjs\n"\n'],
  ['escaped newline after a command', '#!/bin/sh\necho nothing \\\nnode src/core.mjs\n'],
]) {
  test(`shell ${name} cannot fabricate a direct node invocation`, async (t) => {
    const result = await auditNexus({ root: await fixture(t, source) });
    assert.equal(result.status, 'FAIL', name);
    assert.equal(result.checked.evidencedLinks, 0, name);
    assert.ok(result.findings.some((finding) => finding.code === 'DECLARED_LINK_NOT_FOUND'));
  });
}

test('actual static direct node invocation is still evidenced', async (t) => {
  const result = await auditNexus({ root: await fixture(t, '#!/bin/sh\nset -eu\nnode src/core.mjs --out result.json\n') });
  assert.equal(result.status, 'PASS', JSON.stringify(result.findings));
  assert.equal(result.checked.evidencedLinks, 1);
});

test('literal followed by a real direct invocation is evidenced', async (t) => {
  const result = await auditNexus({ root: await fixture(t,
    "#!/bin/sh\nprintf '%s' 'text\\nnode src/core.mjs'\nnode src/core.mjs\n") });
  assert.equal(result.status, 'PASS', JSON.stringify(result.findings));
  assert.equal(result.checked.evidencedLinks, 1);
});

test('quoted or commented heredoc-looking text does not suppress an actual command', async (t) => {
  const result = await auditNexus({ root: await fixture(t,
    "#!/bin/sh\n# cat <<FAKE\nprintf '%s' 'text <<NOT_HEREDOC'\nnode src/core.mjs\n") });
  assert.equal(result.status, 'PASS', JSON.stringify(result.findings));
  assert.equal(result.checked.evidencedLinks, 1);
});

test('real direct command is rejected conservatively if the shell file also has unsupported heredoc syntax', async (t) => {
  const result = await auditNexus({ root: await fixture(t,
    "#!/bin/sh\ncat <<DOC\ntext\nDOC\nnode src/core.mjs\n") });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.checked.evidencedLinks, 0);
});
