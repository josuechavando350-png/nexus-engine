import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectLinuxHost } from '../host-preflight.mjs';

function git(root, ...args) {
  const out=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(out.status,0,`${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'forja-host-'));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'); await mkdir(repo,{mode:0o700});
  git(repo,'init','-q');git(repo,'config','user.name','FORJA fixture');git(repo,'config','user.email','forja@example.invalid');
  await writeFile(join(repo,'fixture.txt'),randomUUID()+'\n',{mode:0o600});
  git(repo,'add','.');git(repo,'commit','-qm','fixture');
  const opts={root:repo};
  for (const [key,name] of [['stateDir','state'],['backupDir','backup'],['receiptsDir','receipts'],['keyDir','keys']]) {
    opts[key]=join(root,name);
    await mkdir(opts[key],{mode:0o700});
  }
  opts.expectedRevision=git(repo,'rev-parse','HEAD');
  return opts;
}
const supported = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0 && Number(process.versions.node.split('.')[0]) >= 24;

test('fail closed on unsupported runtime without falsely reporting Linux host readiness', async t=>{
  const opts=await fixture(t);
  if (!supported) await assert.rejects(inspectLinuxHost(opts), /Linux required|unprivileged user required|Node 24 or newer required/);
  else assert.equal((await inspectLinuxHost(opts)).status, 'PASS');
});

test('unprivileged Node 24 Linux host validates clean exact SHA and disjoint private storage', {skip:!supported}, async t=>{
  const opts=await fixture(t);
  const result=await inspectLinuxHost(opts);
  assert.equal(result.sourceRevision,opts.expectedRevision);
  assert.equal(result.status,'PASS');
  assert.ok(BigInt(result.availableBytes)>0n);
  await assert.rejects(inspectLinuxHost({...opts,expectedRevision:'0'.repeat(40)}),/source revision mismatch/);
  await assert.rejects(inspectLinuxHost({...opts,expectedRevision:''}),/source revision mismatch/);
  await assert.rejects(inspectLinuxHost({...opts,expectedRevision:'not-a-sha'}),/source revision mismatch/);
  await writeFile(join(opts.root,'untracked.txt'),'dirty\n',{mode:0o600});
  await assert.rejects(inspectLinuxHost(opts),/checkout must be clean/);
});

test('reject public, overlapping, symlinked state and existing worker lock', {skip:!supported}, async t=>{
  const opts=await fixture(t);
  await chmod(opts.stateDir,0o755);
  await assert.rejects(inspectLinuxHost(opts),/private directory/);
  await chmod(opts.stateDir,0o700);
  await assert.rejects(inspectLinuxHost({...opts,backupDir:opts.stateDir}),/overlaps state/);
  await mkdir(join(opts.root,'nested'),{mode:0o700});
  await assert.rejects(inspectLinuxHost({...opts,backupDir:join(opts.root,'nested')}),/overlaps checkout/);
  const keyLink=join(opts.stateDir,'linked-keys');
  await symlink(opts.keyDir,keyLink);
  await assert.rejects(inspectLinuxHost({...opts,keyDir:keyLink}),/private directory/);
  await mkdir(join(opts.stateDir,'worker.lock'),{mode:0o700});
  await assert.rejects(inspectLinuxHost(opts),/worker lock exists/);
});
