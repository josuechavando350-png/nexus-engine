#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};

const temp = mkdtempSync(join(tmpdir(), 'nexus-third-party-'));
try {
  const passport = join(temp, 'passport.json');
  const signature = join(temp, 'passport.sig.json');
  writeFileSync(passport, `${JSON.stringify({ authority: 'NEXUS_CI_QUALITY_PASSPORT_V1', passportSha256: 'third-party-proof' })}\n`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  run(process.execPath, ['scripts/passport-sign.mjs', passport, signature], { env: { ...process.env, NEXUS_PASSPORT_PRIVATE_KEY_PEM: privatePem } });
  run(process.execPath, ['scripts/passport-verify.mjs', passport, signature], { env: { ...process.env, NEXUS_PASSPORT_PUBLIC_KEY_PEM: publicPem } });
  const signed = JSON.parse(readFileSync(signature, 'utf8'));
  if (signed.algorithm !== 'Ed25519' || !signed.keyId || !signed.signature) throw new Error('signature envelope incomplete');

  const tampered = join(temp, 'tampered.json');
  writeFileSync(tampered, `${JSON.stringify({ authority: 'NEXUS_CI_QUALITY_PASSPORT_V1', passportSha256: 'tampered' })}\n`);
  const rejected = spawnSync(process.execPath, ['scripts/passport-verify.mjs', tampered, signature], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NEXUS_PASSPORT_PUBLIC_KEY_PEM: publicPem }
  });
  if (rejected.status === 0) throw new Error('tampered passport was accepted');

  const probeName = 'third-party-proof';
  const probePath = join(process.cwd(), 'apps', probeName);
  rmSync(probePath, { recursive: true, force: true });
  run(process.execPath, ['scripts/scaffold-client.mjs', probeName]);
  const manifest = JSON.parse(readFileSync(join(probePath, '.nexus/scaffold-manifest.json'), 'utf8'));
  if (manifest.authority !== 'NEXUS_SCAFFOLD_V1' || manifest.client !== probeName || !manifest.files.length) throw new Error('scaffold manifest invalid');
  rmSync(probePath, { recursive: true, force: true });
  console.log('THIRD_PARTY_PROOF_PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
