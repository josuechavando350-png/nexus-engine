import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getJob, listJobs, queueContext, recoverInterrupted, runNext, submitJob } from '../job-queue.mjs';
const commands = ['inventory','audit','contract','evidence-gate'];
const types = ['AXIOMA_FORJA_GIT_TRACKED_INVENTORY','AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT',
  'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT','AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY'];
const statuses = ['RECORDED','PASS','PASS','CONSISTENT'];
function git(root,...args) {
  const r = spawnSync('git',args,{cwd:root,encoding:'utf8'});
  assert.equal(r.status,0,`${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
async function fixture(t,{failAudit=false}={}) {
  const base = await mkdtemp(join(tmpdir(),'forja-queue-test-'));
  t.after(async()=>rm(base,{recursive:true,force:true}));
  const root = join(base,'repo'); const stateDir = join(base,'state');
  await mkdir(join(root,'forja'),{recursive:true});
  for(let index=0;index<commands.length;index++) {
    const tool=types[index], status=(failAudit && index===1 ? 'FAIL' : statuses[index]);
    const verify=index===3 ? `if(process.argv.length!==5)process.exit(4); for(const p of process.argv.slice(2)){const report=JSON.parse(await (await import('node:fs/promises')).readFile(p,'utf8'));if(!report.sourceRevision)process.exit(5);}` : '';
    await writeFile(join(root,'forja',`${index === 2 ? 'contract-probe' : commands[index]}.mjs`),
      `const tool=${JSON.stringify(tool)}, status=${JSON.stringify(status)};\n${verify}\nconsole.log(JSON.stringify({schemaVersion:1,tool,status,sourceRevision:process.env.FORJA_SOURCE_SHA}));\n`);
  }
  git(root,'init','-q'); git(root,'config','user.email','forja@example.invalid'); git(root,'config','user.name','FORJA test');
  git(root,'add','.'); git(root,'commit','-qm','fixture');
  return {root,stateDir,ctx:await queueContext({root,stateDir})};
}
test('durably executes four fixed real subprocess entrypoints, stores reports and survives new queue instance',async t=>{
  const {root,stateDir,ctx}=await fixture(t);
  const queued=await submitJob(ctx);
  assert.equal(queued.status,'QUEUED');
  const result=await runNext(ctx);
  assert.equal(result.status,'SUCCEEDED',result.error);
  assert.deepEqual(result.completed,['inventory','audit','contract','consistency']);
  assert.equal((await getJob(await queueContext({root,stateDir}),queued.id)).status,'SUCCEEDED');
  const report=JSON.parse(await readFile(join(stateDir,'artifacts',queued.id,'consistency.json'),'utf8'));
  assert.equal(report.sourceRevision,queued.sourceRevision);
  assert.equal(await runNext(ctx),null);
});
test('nonpassing audit fails closed and never invokes downstream contract',async t=>{
  const {ctx,stateDir}=await fixture(t,{failAudit:true});
  const queued=await submitJob(ctx); const result=await runNext(ctx);
  assert.equal(result.status,'FAILED');
  assert.deepEqual(result.completed,['inventory']);
  assert.match(result.error,/audit produced invalid/);
  await assert.rejects(readFile(join(stateDir,'artifacts',queued.id,'contract.json')),{code:'ENOENT'});
});
test('jobs from an earlier Git revision are stale, never silently replayed',async t=>{
  const {ctx,root}=await fixture(t);
  const queued=await submitJob(ctx);
  await writeFile(join(root,'another.txt'),'new revision\n');git(root,'add','.');git(root,'commit','-qm','change');
  const result=await runNext(ctx);
  assert.equal(result.id,queued.id);assert.equal(result.status,'STALE');assert.deepEqual(result.completed,[]);
});
test('a dirty checkout blocks submission',async t=>{
  const {ctx,root}=await fixture(t);
  await writeFile(join(root,'dirty.txt'),'dirty');
  await assert.rejects(submitJob(ctx),/checkout must be clean/);
});
test('state directory inside checkout is rejected',async t=>{
  const {root}=await fixture(t);
  await assert.rejects(queueContext({root,stateDir:join(root,'state')}),/outside checkout/);
});
test('only one worker can acquire the lock; live worker cannot be recovered',async t=>{
  const {ctx}=await fixture(t);await submitJob(ctx);
  await mkdir(ctx.lock);await writeFile(join(ctx.lock,'owner.json'),JSON.stringify({pid:process.pid,host:hostname(),token:randomUUID()}));
  await assert.rejects(runNext(ctx),{code:'EEXIST'});
  await assert.rejects(recoverInterrupted(ctx),/still alive/);
  assert.equal((await listJobs(ctx))[0].status,'QUEUED');
});
test('a crashed owner requires explicit recovery; unfinished jobs become INTERRUPTED',async t=>{
  const {ctx}=await fixture(t);const job=await submitJob(ctx);
  job.status='RUNNING';job.completed=['inventory'];
  await writeFile(join(ctx.jobs,`${job.id}.json`),JSON.stringify(job));
  await mkdir(ctx.lock);await writeFile(join(ctx.lock,'owner.json'),JSON.stringify({pid:99999999,host:hostname(),token:randomUUID()}));
  assert.deepEqual(await recoverInterrupted(ctx),[job.id]);
  assert.equal((await getJob(ctx,job.id)).status,'INTERRUPTED');
  assert.equal(await runNext(ctx),null);
});
test('symlinked records and unsafe identifiers fail closed',async t=>{
  const {ctx}=await fixture(t);
  await assert.rejects(getJob(ctx,'../owner'),/invalid job id/);
  await mkdir(ctx.jobs,{recursive:true});
  const id=randomUUID();await symlink('/etc/passwd',join(ctx.jobs,`${id}.json`));
  await assert.rejects(getJob(ctx,id),/unsafe job record/);
});
test('a malformed JSON record fails closed and does not become an executable job',async t=>{
  const {ctx}=await fixture(t); const job=await submitJob(ctx);
  await writeFile(join(ctx.jobs,`${job.id}.json`),'not-json');
  await assert.rejects(runNext(ctx),SyntaxError);
});
test('recovery refuses foreign-host lock even when its PID looks dead',async t=>{
  const {ctx}=await fixture(t);await mkdir(ctx.lock);
  await writeFile(join(ctx.lock,'owner.json'),JSON.stringify({pid:99999999,host:'different-host',token:randomUUID()}));
  await assert.rejects(recoverInterrupted(ctx),/lock owner cannot be verified/);
});
