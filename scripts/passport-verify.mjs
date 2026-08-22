#!/usr/bin/env node
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [passportPath, signaturePath = `${process.argv[2]}.sig.json`] = process.argv.slice(2);
if (!passportPath) throw new Error('usage: node scripts/passport-verify.mjs <passport.json> [signature.json]');

const publicPem = process.env.NEXUS_PASSPORT_PUBLIC_KEY_PEM;
if (!publicPem) throw new Error('NEXUS_PASSPORT_PUBLIC_KEY_PEM is required');
const payload = readFileSync(passportPath);
JSON.parse(payload.toString('utf8'));
const envelope = JSON.parse(readFileSync(signaturePath, 'utf8'));
if (envelope.authority !== 'NEXUS_QUALITY_PASSPORT_SIGNATURE_V1') throw new Error('unsupported passport signature authority');
if (envelope.algorithm !== 'Ed25519') throw new Error('unsupported passport signature algorithm');
const publicKey = createPublicKey(publicPem.replace(/\\n/g, '\n'));
if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('passport verification key must be Ed25519');
const publicDer = publicKey.export({ type: 'spki', format: 'der' });
const keyId = `ed25519:${createHash('sha256').update(publicDer).digest('hex').slice(0, 24)}`;
if (envelope.keyId !== keyId) throw new Error(`passport key id mismatch: expected ${keyId}, got ${envelope.keyId}`);
const payloadSha256 = createHash('sha256').update(payload).digest('hex');
if (envelope.payloadSha256 !== payloadSha256) throw new Error('passport payload hash mismatch');
const ok = verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64'));
if (!ok) throw new Error('passport signature verification failed');
console.log(`${passportPath}: VERIFIED ${keyId}`);
