import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import {runMotor,MOTOR_REGISTRY} from '../src/index.mjs';
import {squareRootKalman} from '../src/motors/sqrt-kalman.mjs';
const base=new URL('../',import.meta.url),close=(x,y,t=1e-8)=>assert.ok(Math.abs(x-y)<=t,`${x} vs ${y}`);
const sum=a=>a.reduce((v,x)=>v+x,0);
test('all 40 new IDs have JSON fixtures runnable through real standalone CLI',()=>{
 for(let id=61;id<=100;id++){const path=new URL(`examples/motor-${id}.json`,base).pathname;const spec=JSON.parse(readFileSync(path));const proc=spawnSync(process.execPath,['cli.mjs','motor',path,String(id)],{cwd:base,encoding:'utf8',timeout:20000,maxBuffer:3*1024*1024});assert.equal(proc.status,0,`${id}: ${proc.stderr||proc.stdout}`);const output=JSON.parse(proc.stdout);assert.equal(typeof output,'object');assert.ok(output.domain,`motor ${id} missing domain`);assert.equal(typeof MOTOR_REGISTRY[String(id)],'function');if(id===69)assert.equal(output.verified,true);}
});
test('81/89/95 do not silently substitute full cryptographic protocols',()=>{
 for(const [id,label] of [['81','NOT_SIGNATURE'],['89','NOT_FHE'],['95','NOT_GENERAL_ZK_SNARK']]){const result=runMotor(id,JSON.parse(readFileSync(new URL(`examples/motor-${id}.json`,base))));assert.match(result.domain,new RegExp(label));}
 assert.throws(()=>runMotor('101',{}),/not implemented/);
});
test('74 bootstrap particle posterior matches independent scalar Kalman within Monte Carlo tolerance',()=>{
 const filter=runMotor('74',{observations:[1],initialMean:0,initialStd:1,processStd:0,measurementStd:1,particles:4096,seed:14});close(filter.history[0].posteriorMean,.5,.055);close(filter.history[0].posteriorVariance,.5,.065);
});
test('77 projection reduces divergence of nontrivial 3D field and approximately conserves mean velocity',()=>{
 const velocity=Array.from({length:64},(_,k)=>[Math.sin(2*Math.PI*(k%4)/4),0,0]);const r=runMotor('77',{n:4,velocity,viscosity:0,dt:.01,dx:1,steps:1,pressureIterations:350});const idx=(x,y,z)=>((z+4)%4*4+(y+4)%4)*4+(x+4)%4;function div(field){let m=0;for(let z=0;z<4;z++)for(let y=0;y<4;y++)for(let x=0;x<4;x++){const k=idx(x,y,z),v=(field[idx(x+1,y,z)][0]-field[k][0])+(field[idx(x,y+1,z)][1]-field[k][1])+(field[idx(x,y,z+1)][2]-field[k][2]);m=Math.max(m,Math.abs(v));}return m;}
 assert.ok(div(velocity)>1);assert.ok(div(r.velocity)<1e-9,`divergence: ${div(r.velocity)}`);close(sum(r.velocity.map(x=>x[0]))/64,0,1e-9);
});
test('75 temporal and spatial metadata are causal and affect capsule contribution',()=>{
 const input={capsules:[[1],[2]],transforms:[[[[1]],[[1]]]],times:[1,4],queryTime:5,temporalDecay:1,locations:[[0,0],[10,0]],queryLocation:[0,0],spatialDecay:1};const weighted=runMotor('75',input),unweighted=runMotor('75',{capsules:input.capsules,transforms:input.transforms});assert.ok(weighted.outputs[0][0]<unweighted.outputs[0][0]);assert.throws(()=>runMotor('75',{...input,times:[1,6]}),/future/);
});
test('61 exact privacy mechanism formulation and no raw field in serialized output',()=>{
 const r=runMotor('61',{categories:['A','B','C'],responses:['A','B'],epsilon:Math.log(2)});assert.ok(Math.abs(r.reportedCounts.A+r.reportedCounts.B+r.reportedCounts.C-2)<1e-12);assert.equal(r.mechanism,'k-ary randomized response');assert.equal(Object.hasOwn(r,'responses'),false);
});
test('62 future graph events never leak into embeddings, permutation-invariant weighted average',()=>{
 const baseSpec={features:[[1],[2],[3]],events:[{source:0,target:2,time:1},{source:1,target:2,time:2},{source:0,target:2,time:100}],queries:[{node:2,time:3}],projection:[0,0],decay:0};const a=runMotor('62',baseSpec),b=runMotor('62',{...baseSpec,events:baseSpec.events.slice().reverse()});close(a.results[0].embedding[0],1.5);assert.deepEqual(a,b);
});
test('63 two-dimensional linear DMD recovers diagonal map',()=>{
 const r=runMotor('63',{snapshots:[[1,1],[2,3],[4,9],[8,27]],ridge:0,forecastSteps:1});close(r.operator[0][0],2);close(r.operator[0][1],0);close(r.operator[1][0],0);close(r.operator[1][1],3);close(r.forecast[0][1],81);
});
test('64 deterministic-observation POMDP expectation equals exact fully observed return',()=>{
 const s={transition:[[[1,0]],[[0,1]]],observation:[[[1,0],[0,1]]],rewards:[[1],[2]],belief:[.25,.75],horizon:3};close(runMotor('64',s).value,5.25);
});
test('66 Clayton copula matches independent limit as theta→0',()=>{const r=runMotor('66',{u:[.3,.8],theta:1e-6});close(r.jointCdf,.24,1e-6);});
test('71 Jensen–Shannon symmetry and KL asymmetry',()=>{const a=runMotor('71',{p:[.9,.1],q:[.3,.7]}),b=runMotor('71',{p:[.3,.7],q:[.9,.1]});close(a.jensenShannon,b.jensenShannon);assert.notEqual(a.kl,b.kl);});
test('72 constant periodic density is stationary under uniform drift and diffusion',()=>{const r=runMotor('72',{density:[.25,.25,.25,.25],drift:[1,1,1,1],diffusion:.2,dx:1,dt:.1,steps:100});for(const v of r.density)close(v,.25);});
test('73 maximally mixed qubit has unit Pauli covariance and zero coherence',()=>{const zero={re:0,im:0},half={re:.5,im:0};const r=runMotor('73',{density:[[half,zero],[zero,half]]});close(r.purity,.5);close(r.l1Coherence,0);assert.deepEqual(r.covariance,[[1,0,0],[0,1,0],[0,0,1]]);});
test('78 DFA zero signal reports exponent undefined without NaN',()=>{const r=runMotor('78',{series:Array(64).fill(2),scales:[8,16]});assert.equal(r.scalingExponent,null);});
test('80 deterministic no-cost HJB reproduces terminal cost at all horizons',()=>{const r=runMotor('80',{grid:[-1,0,1],controls:[-1,1],terminalCosts:[1,2,3],runningCosts:[[0,0],[0,0],[0,0]],drift:[[0,0],[0,0],[0,0]],diffusion:0,dt:.1,steps:20});assert.deepEqual(r.values,[1,2,3]);});
test('84 Bellman error bound covers empirical optimal-state value error',()=>{const r=runMotor('84',{transitions:[[[1]]],rewards:[[2]],discount:.75,tolerance:1e-6});assert.ok(Math.abs(r.values[0]-8)<=r.bellmanErrorBound+1e-7);});
test('85 rejects a non-positive-definite objective rather than calling nonconvex program convex',()=>{assert.throws(()=>runMotor('85',{H:[[-1]],c:[0],A:[[1]],b:[2],initial:[0]}),/positive definite/);});
test('87 Hawkes single event log likelihood matches analytic compensator',()=>{const r=runMotor('87',{events:[1],baseline:2,alpha:1,beta:1,horizon:3});close(r.logLikelihood,Math.log(2)-6-(1-Math.exp(-2)));});
test('91 partition system discloses that continuum ergodicity is not proved',()=>{const r=runMotor('91',{r:0,bins:4,samplesPerBin:10,steps:50});assert.equal(r.ergodicPartition,false);assert.match(r.warning,/cannot prove/);});
test('93 refuses shared public key masquerading as multiple independent voters',()=>{const kp=generateKeyPairSync('ed25519'),pem=kp.publicKey.export({format:'pem',type:'spki'});assert.throws(()=>runMotor('93',{replicas:['a','b','c'].map(id=>({id,publicKey:pem})),term:1,leader:'a',votes:[],entries:[],commitIndex:0}),/distinct authenticated/);});
test('94 Chentsov contraction for twenty deterministic random channels',()=>{let state=17;const rnd=()=>((state=Math.imul(1664525,state)+1013904223>>>0)+.5)/4294967296;for(let k=0;k<20;k++){const p=[.2,.3,.5],v=[.1,-.07,-.03],channel=Array.from({length:3},()=>{const row=[rnd()+.01,rnd()+.01,rnd()+.01],z=sum(row);return row.map(x=>x/z);});assert.equal(runMotor('94',{p,tangent:v,channel}).contractive,true);}});
test('96 scalar factor Kalman agrees with independent Joseph-Cholesky baseline #46',()=>{const old=squareRootKalman({F:[[1]],H:[[1]],Q:[[.1]],R:[[1]],initialMean:[0],initialCov:[[1]],observations:[[1],null,[2]]});const fresh=runMotor('96',{F:1,H:1,Q:.1,R:1,initialMean:0,initialSqrtVariance:1,observations:[1,null,2]});for(let k=0;k<3;k++){close(old.history[k].mean[0],fresh.history[k].mean);close(old.history[k].sqrtCov[0][0],fresh.history[k].sqrtVariance);}});
test('97 infeasible expectation does not return false convergence',()=>{const r=runMotor('97',{prior:[.5,.5],features:[[0],[1]],targets:[3],iterations:30});assert.equal(r.status,'NOT_CONVERGED');});
test('100 rejects forged signatures and wrong predecessor hash',()=>{const input=JSON.parse(readFileSync(new URL('examples/motor-100.json',base)));assert.equal(runMotor('100',{...input,previousHash:'other'}).verified,false);assert.equal(runMotor('100',{...input,certificate:{...input.certificate,signature:'AAAA'}}).verified,false);});
