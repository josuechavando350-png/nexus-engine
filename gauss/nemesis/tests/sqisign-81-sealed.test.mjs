import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';

test('81: sealed key storage rejects unsafe paths, missing trust pins and weak passphrases before native execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis81-vault-negative-'));
  chmodSync(dir,0o700);
  try{
    const common={action:'sqisign-keygen-sealed',keyPath:join(dir,'secret.enc'),
      passphrase:'CI-only-long-test-passphrase-never-use-in-production',
      binary:'/definitely-missing-sqisign-native-binary',expectedBinarySha256:'a'.repeat(64)};
    await assert.rejects(()=>runGaussNemesis(81,{...common,passphrase:'short'}),/INVALID_PASSPHRASE/);
    await assert.rejects(()=>runGaussNemesis(81,{...common,keyPath:'relative-secret.enc'}),/INVALID_PATH/);
    await assert.rejects(()=>runGaussNemesis(81,{...common,expectedBinarySha256:undefined}),/trusted/);
    await assert.rejects(()=>runGaussNemesis(81,{...common}),/BINARY_MISSING/);
    chmodSync(dir,0o755);
    await assert.rejects(()=>runGaussNemesis(81,{...common}),/UNSAFE_DIRECTORY/);
    chmodSync(dir,0o700);
    await assert.rejects(()=>runGaussNemesis(81,{...common,action:'sqisign-sign-sealed',
      expectedKeyId:'0'.repeat(64),messageBase64:'aGVsbG8='}),/UNSAFE_FILE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
