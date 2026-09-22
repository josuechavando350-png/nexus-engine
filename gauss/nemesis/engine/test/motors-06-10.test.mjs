import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateQuantumWalk, smoothLinearGaussian, runOpeningProof, updateBinaryBayesEvents,
  runMirroredAgents, MOTOR_REGISTRY, runMotor } from '../src/motors/index.mjs';
import { createPedersenCommitment, provePedersenOpening, verifyPedersenOpening, PUBLIC_ZK_GROUP } from '../src/motors/zk-opening.mjs';
import { createBinaryBayesStream } from '../src/motors/bayes-stream.mjs';
const approx = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} vs ${expected}`);
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));

test('06 continuous 2-node walk matches analytic cos²/sin² for negative and positive times', () => {
  const input = fixture('quantum-walk-two-vertices');
  for (const time of [-6, -Math.PI, -Math.PI / 2, 0, 0.25, 0.75, Math.PI / 2, Math.PI, 6]) {
    const result = simulateQuantumWalk({ ...input, time });
    approx(result.probabilities[0], Math.cos(time) ** 2);
    approx(result.probabilities[1], Math.sin(time) ** 2);
    approx(result.norm, 1);
  }
});
test('06 continuous disconnected vertices cannot carry amplitude across components', () => {
  const r = simulateQuantumWalk({ mode:'continuous', vertices:4, edges:[{u:0,v:1},{u:2,v:3}], start:0,time:5 });
  approx(r.probabilities[2], 0); approx(r.probabilities[3], 0);
});
test('06 independent edge solver: CTQW of one weighted edge has sin²(weight*time)', () => {
  for (let w=1;w<=4;w++) for (const t of [0.1,0.5,1,2]) {
    const r=simulateQuantumWalk({mode:'continuous',vertices:2,edges:[{u:0,v:1,weight:w}],start:0,time:t});
    approx(r.probabilities[1],Math.sin(w*t)**2,1e-9);
  }
});
test('06 discrete Grover flip flop on one edge alternates deterministically', () => {
  for (let steps=0;steps<10;steps++) {
    const r=simulateQuantumWalk({mode:'discrete',vertices:2,edges:[{u:0,v:1}],start:0,steps});
    approx(r.probabilities[steps%2],1); approx(r.probabilities[1-steps%2],0); approx(r.norm,1);
  }
});
test('06 discrete cycle norm retained and invalid graphs rejected', () => {
  const r=simulateQuantumWalk({mode:'discrete',vertices:4,edges:[{u:0,v:1},{u:1,v:2},{u:2,v:3},{u:3,v:0}],start:0,steps:100});
  approx(r.probabilities.reduce((a,b)=>a+b,0),1);
  assert.throws(()=>simulateQuantumWalk({mode:'discrete',vertices:3,edges:[{u:0,v:1}],start:0,steps:1}),/isolated/);
  assert.throws(()=>simulateQuantumWalk({mode:'continuous',vertices:3,edges:[{u:0,v:1},{u:1,v:0}],start:0,time:1}),/duplicate/);
  assert.throws(()=>simulateQuantumWalk({mode:'continuous',vertices:2,edges:[{u:0,v:1}],start:0,time:21}),/invalid finite/);
});

test('07 scalar Kalman RTS agrees with separately written scalar recursion', () => {
  const input=fixture('kalman-rts'); const result=smoothLinearGaussian(input);
  let x=0,p=1; const pred=[],filter=[];
  for(const y of input.observations) {
    pred.push({x,p});
    if(y!==null) { const k=p/(p+0.25); x=x+k*(y[0]-x); p=(1-k)*p; }
    filter.push({x,p}); x=x; p+=0.1;
  }
  let sx=filter.at(-1).x,sp=filter.at(-1).p;
  approx(result.smoothed.at(-1).mean[0],sx); approx(result.smoothed.at(-1).covariance[0][0],sp);
  for(let t=filter.length-2;t>=0;t--) {
    const j=filter[t].p/pred[t+1].p;
    sx=filter[t].x+j*(sx-pred[t+1].x);
    sp=filter[t].p+j*j*(sp-pred[t+1].p);
    approx(result.smoothed[t].mean[0],sx,1e-9);
    approx(result.smoothed[t].covariance[0][0],sp,1e-9);
  }
});
test('07 multivariate 2-D model filters and smooths with positive covariance', () => {
  const spec={ F:[[1,1],[0,1]],H:[[1,0]],Q:[[0.01,0],[0,0.01]],R:[[0.1]],initialMean:[0,1],initialCovariance:[[1,0],[0,1]], observations:[[0],[1],null,[3],[4]] };
  const r=smoothLinearGaussian(spec);
  assert.equal(r.dimension,2); assert.equal(r.missingObservations,1);
  assert.deepEqual(r.filtered[2],r.predicted[2]);
  for (const state of r.smoothed) { assert.ok(state.covariance[0][0]>0 && state.covariance[1][1]>0); approx(state.covariance[0][1],state.covariance[1][0]); }
  approx(r.smoothed.at(-1).mean[0],r.filtered.at(-1).mean[0]);
});
test('07 rejects nonsymmetric and indefinite covariance instead of returning unjustified results', () => {
  const input=fixture('kalman-rts');
  assert.throws(()=>smoothLinearGaussian({...input,Q:[[0]]}),/positive definite/);
  assert.throws(()=>smoothLinearGaussian({...input,R:[[-1]]}),/positive definite/);
  assert.throws(()=>smoothLinearGaussian({...input,observations:[[1,2]]}),/1..1/);
});

test('08 Pedersen group is subgroup; generated opening proofs verify without disclosing opening', () => {
  assert.ok(PUBLIC_ZK_GROUP.p.length >= 500);
  for(const value of [0,1,42,1000000000]) {
    const c=createPedersenCommitment(value),proof=provePedersenOpening(c.commitment,c.opening);
    assert.equal(verifyPedersenOpening(c.commitment,proof),true);
    assert.equal(Object.hasOwn(proof,'blind'),false); assert.equal(Object.hasOwn(proof,'value'),false);
    assert.equal(runOpeningProof({action:'verify',commitment:c.commitment,proof}).verified,true);
  }
});
test('08 two randomized commitments to same value differ and tampered proof fails', () => {
  const a=createPedersenCommitment(7),b=createPedersenCommitment(7);
  assert.notEqual(a.commitment,b.commitment);
  const proof=provePedersenOpening(a.commitment,a.opening);
  assert.equal(verifyPedersenOpening(a.commitment,{...proof,zValue:proof.zBlind}),false);
  assert.equal(verifyPedersenOpening(b.commitment,proof),false);
  assert.throws(()=>provePedersenOpening(b.commitment,a.opening),/does not match/);
  assert.throws(()=>verifyPedersenOpening('0',proof),/canonical hexadecimal element/);
  assert.throws(()=>runOpeningProof({action:'commit',value:-1}),/safe integer/);
});
test('08 dispatcher commit→prove→verify uses public statement only on verify', () => {
  const c=runOpeningProof({action:'commit',value:123});
  const {proof}=runOpeningProof({action:'prove',commitment:c.commitment,opening:c.opening});
  assert.equal(runOpeningProof({action:'verify',commitment:c.commitment,proof}).verified,true);
});

test('09 exact Bayesian stream sorted by event timestamps gives 6/7', () => {
  const r=updateBinaryBayesEvents(fixture('bayes-event-stream'));
  assert.equal(r.posteriorTrue,'6/7'); assert.deepEqual(r.timeline.map(t=>t.id),['test_A','test_B']);
  assert.equal(r.timeline[0].posteriorTrue,'3/4');
});
test('09 out-of-order replay and duplicate ID idempotence', () => {
  const input=fixture('bayes-event-stream'),stream=createBinaryBayesStream(input.priorTrue);
  const b=stream.ingest(input.events[0]); assert.equal(b.duplicate,false);
  const a=stream.ingest(input.events[1]); assert.equal(a.report.posteriorTrue,'6/7');
  assert.equal(stream.ingest(input.events[1]).duplicate,true);
  assert.equal(stream.snapshot().processedEvents,2);
  assert.throws(()=>stream.ingest({...input.events[1],likelihoodIfTrue:'1/2'}),/conflicting/);
  assert.equal(stream.snapshot().posteriorTrue,'6/7');
});
test('09 zero-likelihood events fail transactionally and event inputs are immutable snapshots', () => {
  const stream=createBinaryBayesStream('1/2');
  const good={id:'ok',time:0,likelihoodIfTrue:'1/2',likelihoodIfFalse:'1/2'};
  stream.ingest(good);
  assert.throws(()=>stream.ingest({id:'impossible',time:1,likelihoodIfTrue:'0',likelihoodIfFalse:'0'}),/zero probability/);
  assert.equal(stream.snapshot().processedEvents,1);
  const snapshot=stream.snapshot(); snapshot.timeline[0].posteriorTrue='999/1';
  assert.equal(stream.snapshot().posteriorTrue,'1/2');
});

test('10 actual worker threads independently agree on valid finite agent', async () => {
  const r=await runMirroredAgents(fixture('mirrored-agent'));
  assert.equal(r.status,'CONSISTENT'); assert.equal(r.actualWorkerThreads,2); assert.equal(r.errors.length,0);
  assert.equal(r.replicas[0].finalState,'done'); assert.equal(r.replicas[0].digest,r.replicas[1].digest);
  assert.equal(r.replicas[0].trace.length,2);
});
test('10 injected replica-specific fault produces reproducible divergence', async () => {
  const r=await runMirroredAgents({...fixture('mirrored-agent'),fault:{replica:2,step:0,overrideState:'error'}});
  assert.equal(r.status,'DIVERGED'); assert.equal(r.firstDivergenceStep,0);
  assert.equal(r.replicas[0].finalState,'done'); assert.equal(r.replicas[1],null);
  assert.match(r.errors[0].message,/not enabled/);
});
test('10 divergence on last step retains both worker traces', async () => {
  const r=await runMirroredAgents({...fixture('mirrored-agent'),fault:{replica:2,step:1,overrideState:'error'}});
  assert.equal(r.status,'DIVERGED'); assert.equal(r.firstDivergenceStep,1);
  assert.equal(r.replicas[0].trace.length,r.replicas[1].trace.length);
});
test('10 both workers agreeing on unsafe state still fails invariant', async () => {
  const spec=fixture('mirrored-agent'); spec.schedule[1].action='reject';
  const r=await runMirroredAgents(spec);
  assert.equal(r.status,'INVARIANT_VIOLATION'); assert.equal(r.replicas[0].forbiddenVisited[0].state,'error');
});
test('10 invalid transition and schedule cannot claim consistency', async () => {
  const spec=fixture('mirrored-agent');
  await assert.rejects(runMirroredAgents({...spec,transitions:[...spec.transitions,spec.transitions[0]]}),/duplicates/);
  await assert.rejects(runMirroredAgents({...spec,schedule:[{time:10,action:'submit'},{time:1,action:'approve'}]}),/monotone/);
  const r=await runMirroredAgents({...spec,schedule:[{time:0,action:'approve'}]});
  assert.equal(r.status,'DIVERGED'); assert.equal(r.errors.length,2);
});
test('06..10 registry integrates existing engines without stubs', async () => {
  assert.deepEqual(Object.keys(MOTOR_REGISTRY).sort((a,b)=>Number(a)-Number(b)),Array.from({length:99},(_,i)=>String(i+2).padStart(2,'0')));
  assert.equal((await runMotor('06',fixture('quantum-walk-two-vertices'))).engine,'NEMESIS_QUANTUM_WALK_V1');
  assert.equal((await runMotor('07',fixture('kalman-rts'))).engine,'NEMESIS_LINEAR_KALMAN_RTS_V1');
  assert.equal((await runMotor('09',fixture('bayes-event-stream'))).posteriorTrue,'6/7');
  assert.equal((await runMotor('10',fixture('mirrored-agent'))).status,'CONSISTENT');
  assert.throws(()=>runMotor('101',{}),/not implemented/);
});

test('06..10 CLI runs each example and returns 1 for divergence, 2 for secret-bearing commit', () => {
  const root = new URL('../', import.meta.url).pathname;
  for (const [id,example] of [['06','quantum-walk-two-vertices'],['07','kalman-rts'],['09','bayes-event-stream'],['10','mirrored-agent']]) {
    const run=spawnSync(process.execPath,['cli.mjs','motor',join(root,'examples',`${example}.json`),id],{cwd:root,encoding:'utf8'});
    assert.equal(run.status,0,`motor ${id}: ${run.stderr}`);
    assert.ok(JSON.parse(run.stdout).engine);
  }
  const dir=mkdtempSync(join(tmpdir(),'nemesis-cli-'));
  try {
    const base=fixture('mirrored-agent');
    const faultPath=join(dir,'fault.json'); writeFileSync(faultPath,JSON.stringify({...base,fault:{replica:2,step:1,overrideState:'error'}}));
    const diverged=spawnSync(process.execPath,['cli.mjs','motor',faultPath,'10'],{cwd:root,encoding:'utf8'});
    assert.equal(diverged.status,1); assert.equal(JSON.parse(diverged.stdout).status,'DIVERGED');
    const c=createPedersenCommitment(7),proof=provePedersenOpening(c.commitment,c.opening);
    const proofPath=join(dir,'public.json'); writeFileSync(proofPath,JSON.stringify({action:'verify',commitment:c.commitment,proof}));
    const verified=spawnSync(process.execPath,['cli.mjs','motor',proofPath,'08'],{cwd:root,encoding:'utf8'});
    assert.equal(verified.status,0,verified.stderr); assert.equal(JSON.parse(verified.stdout).verified,true);
    const commitPath=join(dir,'secret.json'); writeFileSync(commitPath,JSON.stringify({action:'commit',value:7}));
    const refused=spawnSync(process.execPath,['cli.mjs','motor',commitPath,'08'],{cwd:root,encoding:'utf8'});
    assert.equal(refused.status,2); assert.equal(refused.stdout,'');
    assert.match(refused.stderr,/Refusing to print a private/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
