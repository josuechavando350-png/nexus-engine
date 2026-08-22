#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [passportPath, signaturePath = `${process.argv[2]}.sig.json`] = process.argv.slice(2);
if (!passportPath) throw new Error('usage: node scripts/passport-sign.mjs <passport.json> [signature.json]');

const privatePem = process.env.NEXUS_PASSPORT_PRIVATE_KEY_PEM;
if (!privatePem) throw new Error('NEXUS_PASSPORT_PRIVATE_KEY_PEM is required');

const payload = readFileSync(passportPath);
JSON.parse(payload.toString('utf8'));
const privateKey = createPrivateKey(privatePem.replace(/\\n/g, '\n'));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('passport signing key must be Ed25519');
const publicKey = createPublicKey(privateKey);
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
const keyId = `ed25519:${createHash('sha256').update(publicDer).digest('hex').slice(0, 24)}`;
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
const signature = sign(null, payload, privateKey).toString('base64');
const envelope = {
  authority: 'NEXUS_QUALITY_PASSPORT_SIGNATURE_V1',
  algorithm: 'Ed25519',
  keyId,
  payloadSha256,
  signature
};
writeFileSync(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`);
console.log(`${passportPath}: signed ${keyId} -> ${signaturePath}`);
