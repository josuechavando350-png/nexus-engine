import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runGaussNemesis81Signature} from '../native-sqisign-81.mjs';

const key = Buffer.alloc(270, 87).toString('base64');
const message = Buffer.from('private-message-canary').toString('base64');

test('81: signature entry requires a trusted binary pin and fails closed if absent', () => {
  assert.throws(() => runGaussNemesis81Signature({action:'sqisign-keygen', expectedBinarySha256:'untrusted'}), /trusted/);
  assert.throws(() => runGaussNemesis81Signature({action:'sqisign-keygen',expectedBinarySha256:'0'.repeat(64),binary:'/no-such-file'}), /BINARY_MISSING/);
});
test('81: refuse invalid keys, actions and unsupported fields before native execution', () => {
  const common = {action:'sqisign-sign',expectedBinarySha256:'0'.repeat(64), binary:'/missing', messageBase64:message};
  assert.throws(() => runGaussNemesis81Signature({...common, secretKeyBase64:'AAAA'}), /secret key/);
  assert.throws(() => runGaussNemesis81Signature({...common, secretKeyBase64:key, messageBase64:'ab=+'}), /base64/);
  assert.throws(() => runGaussNemesis81Signature({...common, secretKeyBase64:key, extra:true}), /unexpected/);
  assert.throws(() => runGaussNemesis81Signature({...common, action:'pseudo-signature', secretKeyBase64:key}), /unsupported/);
});
test('81: compromised or deliberately malicious backend cannot echo private key in an exception', () => {
  const dir=mkdtempSync(join(tmpdir(),'nemesis81-negative-'));
  try {
    const binary=join(dir,'fake');
    // Fake backend is a NEGATIVE test only. Real positive signing tests require upstream SQIsign.
    writeFileSync(binary,"#!/bin/sh\ncat >/dev/null\nprintf 'private-message-canary' >&2\nexit 23\n",{mode:0o700});
    const pin=createHash('sha256').update('#!/bin/sh\ncat >/dev/null\nprintf \'private-message-canary\' >&2\nexit 23\n').digest('hex');
    assert.throws(() => runGaussNemesis81Signature({action:'sqisign-sign', expectedBinarySha256:pin,
      binary, secretKeyBase64:key, messageBase64:message}), e=>
      e.message==='NEMESIS_81_NATIVE_EXECUTION_FAILED' && !e.message.includes('private-message-canary') && !e.message.includes(key));
    assert.throws(() => runGaussNemesis81Signature({action:'sqisign-sign', expectedBinarySha256:'f'.repeat(64),
      binary, secretKeyBase64:key, messageBase64:message}),/PIN_MISMATCH/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
