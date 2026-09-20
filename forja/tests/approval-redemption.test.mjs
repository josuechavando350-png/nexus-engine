import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { redeemApproval } from '../approval-redemption.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'forja-redemption-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stateDir = join(base, 'private');
  await mkdir(stateDir, { mode: 0o700 });
  return { base, stateDir, root: join(base, 'repo'), id: randomUUID(),
    envelope: { challenge: { nonce: randomUUID() } }, trustedOperators: {} };
}

test('missing or nonabsolute state cannot consume an approval', async (t) => {
  const options = await fixture(t);
  await assert.rejects(redeemApproval({ ...options, stateDir: 'relative' }), /absolute state/);
  await assert.rejects(redeemApproval({ ...options, stateDir: join(options.base, 'absent') }), /ENOENT/);
});

test('symlinked state root and world-accessible state root are refused', async (t) => {
  const options = await fixture(t);
  const link = join(options.base, 'link');
  await symlink(options.stateDir, link, 'dir');
  await assert.rejects(redeemApproval({ ...options, stateDir: link }), /owned private directory/);
  await mkdir(join(options.base, 'public'), { mode: 0o755 });
  await assert.rejects(redeemApproval({ ...options, stateDir: join(options.base, 'public') }), /owned private directory/);
});

test('unverified or incomplete job cannot reserve a nonce or create redemption directory', async (t) => {
  const options = await fixture(t);
  await mkdir(join(options.stateDir, 'jobs'), { mode: 0o700 });
  await writeFile(join(options.stateDir, 'jobs', `${options.id}.json`), '{}');
  await assert.rejects(redeemApproval(options));
  assert.equal((await readdir(options.stateDir)).includes('approval-redemptions'), false);
});
