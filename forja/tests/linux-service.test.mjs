import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { guardLinuxWorker, renderLinuxUserUnit } from '../linux-service.mjs';

function git(root,...args) {
  const out=spawnSync('git',args,{cwd:root,encoding:'utf8'});
  assert.equal(out.status,0,`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}
async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'forja-linux-user-'));
  await chmod(home,0o700);
  t.after(()=>rm(home,{recursive:true,force:true}));
  const root=join(home,'repo'), state=join(home,'state');
  await mkdir(join(root,'forja'),{recursive:true});
  await mkdir(state,{mode:0o700});
  for(const file of ['linux-service.mjs','job-queue.mjs']) {
    await copyFile(fileURLToPath(new URL(`../${file}`,import.meta.url)),join(root,'forja',file));
  }
  git(root,'init','-q');git(root,'config','user.email','forja-test@example.invalid');
  git(root,'config','user.name','FORJA test');git(root,'add','.');git(root,'commit','-qm','fixture');
  return {home,root,state,sha:git(root,'rev-parse','HEAD')};
}

test('generates a precise reviewable unprivileged user unit from committed bytes and an external state', async(t)=>{
  const f=await fixture(t);
  const rendered=await renderLinuxUserUnit(f.root,f.state);
  assert.equal(rendered.sourceRevision,f.sha);
  assert.match(rendered.unit,new RegExp(`guard ${f.root} ${f.state} ${f.sha}`));
  assert.match(rendered.unit,new RegExp(`serve ${f.state}`));
  for (const setting of ['Type=simple','KillMode=mixed','TimeoutStopSec=600s','Restart=on-failure',
    'NoNewPrivileges=true','UMask=0077','PrivateTmp=true','WantedBy=default.target']) {
    assert.ok(rendered.unit.includes(setting),setting);
  }
  assert.doesNotMatch(rendered.unit,/sudo|curl|docker|EnvironmentFile=|ExecStartPost=/);
  assert.deepEqual(await guardLinuxWorker(f.root,f.state,f.sha),
    {sourceRevision:f.sha,state:f.state,status:'READY_FOR_LOCAL_READ_ONLY_WORKER'});
  const out=join(f.home,'forja.service');await writeFile(out,rendered.unit,{mode:0o600});
  const result=spawnSync('systemd-analyze',['verify',out],{encoding:'utf8',timeout:15000});
  if (!result.error || result.error.code !== 'ENOENT') {
    assert.equal(result.status,0,`systemd unit rejected: ${result.stderr}`);
  }
});

test('does not start after a checkout revision changes or when the checkout is dirty',async(t)=>{
  const f=await fixture(t);
  const {sourceRevision}=await renderLinuxUserUnit(f.root,f.state);
  await writeFile(join(f.root,'dirty.txt'),'not committed');
  await assert.rejects(guardLinuxWorker(f.root,f.state,sourceRevision),/clean exact Git SHA/);
  await assert.rejects(renderLinuxUserUnit(f.root,f.state),/clean exact Git SHA/);
  git(f.root,'add','.');git(f.root,'commit','-qm','updated');
  await assert.rejects(guardLinuxWorker(f.root,f.state,sourceRevision),/checkout SHA changed/);
  assert.notEqual((await renderLinuxUserUnit(f.root,f.state)).sourceRevision,sourceRevision);
});

test('stale worker lock blocks service startup; no automatic recovery or deletion',async(t)=>{
  const f=await fixture(t);
  await mkdir(join(f.state,'worker.lock'),{mode:0o700});
  await assert.rejects(guardLinuxWorker(f.root,f.state,f.sha),/worker lock exists/);
  await assert.rejects(guardLinuxWorker(f.root,f.state,f.sha),/worker lock exists/);
});

test('public, symlinked, nested and systemd-interpolated state paths fail closed',async(t)=>{
  const f=await fixture(t);
  await chmod(f.state,0o755);
  await assert.rejects(renderLinuxUserUnit(f.root,f.state),/private and owned/);
  await chmod(f.state,0o700);
  await symlink(f.state,join(f.home,'state-link'));
  await assert.rejects(renderLinuxUserUnit(f.root,join(f.home,'state-link')),/private and owned/);
  await assert.rejects(renderLinuxUserUnit(f.root,join(f.root,'state')),/ENOENT|disjoint/);
  await assert.rejects(renderLinuxUserUnit(f.root,`${f.state}%n`),/canonical absolute path/);
  await assert.rejects(renderLinuxUserUnit(f.root,`${f.state} bad`),/canonical absolute path/);
});

test('rejects malformed source identity and requires the actual FORJA entrypoint',async(t)=>{
  const f=await fixture(t);
  await assert.rejects(guardLinuxWorker(f.root,f.state,'main'),/expected source SHA/);
  const file=join(f.root,'forja','job-queue.mjs');
  await rm(file);
  await assert.rejects(renderLinuxUserUnit(f.root,f.state),/FORJA worker entrypoint unavailable/);
});
