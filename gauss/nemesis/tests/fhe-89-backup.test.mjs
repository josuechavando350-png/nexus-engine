import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync,linkSync,lstatSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis89Backup} from '../fhe-89-backup.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
test('89 sealed recovery fails closed before touching existing keys or invoking native TFHE',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis89-recovery-negative-'));
  chmodSync(dir,0o700);
  try{
    const serverPath=join(dir,'server.key'),vaultPath=join(dir,'missing-client.vault');
    writeFileSync(serverPath,'not an actual TFHE server key',{mode:0o600});
    const backupVaultPath=join(dir,'backup.vault'),backupServerPath=join(dir,'backup.server');
    const req={action:'sealed-backup',binary:'/this-binary-must-not-be-invoked',expectedBinarySha256:'a'.repeat(64),
      vaultPath,serverPath,passphrase:'long-unused-test-passphrase-123',serverKeySha256:hash('not an actual TFHE server key'),
      backupVaultPath,backupServerPath,backupPassphrase:'long-new-test-passphrase-456'};
    assert.throws(()=>runGaussNemesis89Backup({...req,serverKeySha256:'0'.repeat(64)}),/SERVER_PIN_MISMATCH/);
    assert.equal(lstatSync(backupServerPath,{throwIfNoEntry:false}),undefined);
    assert.throws(()=>runGaussNemesis89Backup(req),/UNSAFE_FILE/);
    assert.equal(lstatSync(backupServerPath,{throwIfNoEntry:false}),undefined,'failed backup must roll back only its own server artifact');
    assert.equal(lstatSync(backupVaultPath,{throwIfNoEntry:false}),undefined);
    writeFileSync(backupServerPath,'PREEXISTING',{mode:0o600});
    assert.throws(()=>runGaussNemesis89Backup(req),/DESTINATION_EXISTS/);
    assert.equal(lstatSync(backupServerPath).size,11,'never overwrite a pre-existing backup');
    rmSync(backupServerPath);
    const linked=join(dir,'server-linked.key');symlinkSync(serverPath,linked);
    assert.throws(()=>runGaussNemesis89Backup({...req,serverPath:linked}),/UNSAFE_FILE/);
    rmSync(linked);
    const hard=join(dir,'server-hardlink.key');linkSync(serverPath,hard);
    assert.throws(()=>runGaussNemesis89Backup(req),/UNSAFE_FILE/);
    rmSync(hard);
    chmodSync(dir,0o755);
    assert.throws(()=>runGaussNemesis89Backup(req),/PRIVATE_DIRECTORY/);
  }finally{chmodSync(dir,0o700);rmSync(dir,{recursive:true,force:true});}
});
