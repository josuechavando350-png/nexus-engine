#!/usr/bin/env node
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMemoryCms, defineCmsSchema, parseCmsDocument } from '../lib/cms-lite.mjs';

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};

const schema = defineCmsSchema((input) => {
  if (!input || typeof input !== 'object' || typeof input.title !== 'string') throw new Error('title required');
  return { title: input.title };
});
const document = parseCmsDocument({ slug: 'home', locale: 'es-MX', data: { title: 'NEXUS' } }, schema);
const cms = createMemoryCms([document]);
if (cms.get('home')?.data.title !== 'NEXUS' || cms.list().length !== 1) throw new Error('cms-lite public surface failed');

const probeName = `third-party-proof-${process.pid}`;
const probePath = join(process.cwd(), 'apps', probeName);
rmSync(probePath, { recursive: true, force: true });
try {
  run(process.execPath, ['scripts/scaffold-client.mjs', probeName]);
  const manifest = JSON.parse(readFileSync(join(probePath, '.nexus/scaffold-manifest.json'), 'utf8'));
  if (manifest.authority !== 'NEXUS_SCAFFOLD_V1' || manifest.client !== probeName || !manifest.files.length) throw new Error('scaffold manifest invalid');
} finally {
  rmSync(probePath, { recursive: true, force: true });
}

run(process.execPath, ['scripts/verify-declared-assets.mjs']);
console.log('THIRD_PARTY_PROOF_PASS');
console.log('PASSPORT_SIGNATURE_PROOF_PENDING_KEY_MODEL_DECISION');
