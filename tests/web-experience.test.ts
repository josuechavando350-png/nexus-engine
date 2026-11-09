import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('optional web-experience source kit passes its offline contract suite', () => {
  const output = execFileSync(process.execPath, [
    '--test', fileURLToPath(new URL('./web-experience.contract.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  expect(output).toContain('# fail 0');
}, 35_000);
