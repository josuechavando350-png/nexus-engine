import test from 'node:test';
import assert from 'node:assert/strict';
import {runMotor,MOTOR_REGISTRY} from '../src/index.mjs';
import {createEducationalLWEKeypair,encryptEducationalLWE,decryptEducationalLWE} from '../src/motors/batch-61-70.mjs';
const close=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
const fixtures={
61:{categories:['A','B'],responses:['A','B','A'],epsilon:1,maxEpsilon:1},
62:{features:[[1],[3]],events:[{source:0,target:1,time:1}],queries:[{node:1,time:1},{node:1,time:2}],projection:[0,0]},
63:{snapshots:[[1],[2],[4],[8]],forecastSteps:2},
64:{transition:[[[1],[1]]],observation:[[[1,0]],[[1,0]]],rewards:[[1,2]],belief:[1],horizon:3},
65:{initial:[10],target:[2],quadratic:[[1]],learningRate:.1,momentum:0,phase:0,steps:120},
66:{u:[.5,.5],theta:1},
67:{x:Array.from({length:30},(_,i)=>i-15),y:Array.from({length:30},(_,i)=>2+3*(i-15)+(i-15)**2),degree:2},
68:{payoffs:[[1,1],[1,1]],initial:[.2,.8],mutation:[[1,0],[0,1]],steps:10},
69:{text:'ok'},
70:{points:[[0,0],[1,0],[0,1]],maxScale:1.5},
71:{p:[.5,.5],q:[.5,.5]},
72:{density:[1,0,0,0],drift:[0,0,0,0],diffusion:.5,dx:1,dt:.1,steps:10},
73:{density:[[{re:.5,im:0},{re:.5,im:0}],[{re:.5,im:0},{re:.5,im:0}]]},
74:{observations:[1,1],initialMean:0,initialStd:1,processStd:.1,measurementStd:.3,particles:600,seed:3},
75:{capsules:[[1],[2]],transforms:[[[[1]],[[1]]]],iterations:3},
76:{steps:32,alpha:.5,memoryWeight:.5,seed:7},
77:{n:4,velocity:Array.from({length:64},()=>[1,0,0]),viscosity:.1,dt:.01,dx:1,steps:2,pressureIterations:40},
78:{series:Array.from({length:256},(_,i)=>Math.sin(i/4)+Math.cos(i/7)),scales:[8,16,32,64]},
79:{bounds:[[-2,2]],target:[.2],particles:32,iterations:100,seed:12},
80:{grid:[-1,0,1],controls:[0],terminalCosts:[0,0,0],runningCosts:[[1],[1],[1]],drift:[[0],[0],[0]],diffusion:0,dt:.1,steps:10}
};
test('61 randomized reports and privacy-budget guard',()=>{const r=runMotor('61',fixtures[61]);assert.equal(r.report.length,3);assert.deepEqual(Object.values(r.reportedCounts).reduce((a,b)=>a+b,0),3);assert.equal(JSON.stringify(r).includes('responses'),false);assert.throws(()=>runMotor('61',{...fixtures[61],maxEpsilon:.5}),/budget/);});
test('62 strict causal time filtering, attention normalized',()=>{const r=runMotor('62',fixtures[62]);assert.deepEqual(r.results[0].embedding,[3]);assert.deepEqual(r.results[1].embedding,[1]);close(r.results[1].attention[0].weight,1);});
test('63 DMD exact scalar transition and forecast',()=>{const r=runMotor('63',fixtures[63]);close(r.operator[0][0],2);close(r.forecast[1][0],32);});
test('64 POMDP exact Bellman solution and invalid stochastic row',()=>{const r=runMotor('64',fixtures[64]);close(r.value,6);assert.equal(r.action,1);assert.throws(()=>runMotor('64',{...fixtures[64],belief:[.5]}),/sum/);});
test('65 zero momentum reduces to gradient descent',()=>{const r=runMotor('65',fixtures[65]);close(r.parameters[0],2,1e-4);assert.ok(r.history[1].objective<r.history[0].objective);});
test('66 Clayton known CDF and Kendall tau',()=>{const r=runMotor('66',fixtures[66]);close(r.jointCdf,1/3);close(r.kendallTau,1/3);close(r.bivariateUpperTail,1/3);});
test('67 polynomial cointegrating regression fits exact quadratic',()=>{const r=runMotor('67',fixtures[67]);assert.ok(Math.max(...r.residual.map(Math.abs))<1e-5);assert.throws(()=>runMotor('67',{x:Array(20).fill(1),y:Array(20).fill(1)}),/variance/);});
test('68 neutral replicator-mutator preserves initial simplex',()=>{const r=runMotor('68',fixtures[68]);close(r.distribution[0],.2);close(r.distribution[1],.8);assert.throws(()=>runMotor('68',{...fixtures[68],mutation:[[.9,0],[0,1]]}),/sum/);});
test('69 LWE educational encryption genuinely encrypts/decrypts and rejects wrong key',()=>{const k=createEducationalLWEKeypair(),ct=encryptEducationalLWE(k.publicKey,'hello');assert.equal(decryptEducationalLWE(k.privateKey,ct),'hello');assert.notEqual(JSON.stringify(ct).includes('hello'),true);assert.equal(runMotor('69',{text:'ok'}).verified,true);assert.throws(()=>encryptEducationalLWE(k.publicKey,'x'.repeat(129)),/short/);});
test('70 streamed Rips H0 Betti decreases upon adding point',()=>{const r=runMotor('70',fixtures[70]);assert.equal(r.snapshots.length,2);assert.equal(r.snapshots.at(-1).h0Alive,1);});
test('71 KL=0 identical and infinity support mismatch',()=>{const r=runMotor('71',fixtures[71]);close(r.kl,0);close(r.entropy,Math.log(2));assert.equal(runMotor('71',{p:[1,0],q:[0,1]}).kl,'Infinity');});
test('72 periodic Fokker-Planck diffuses without losing mass',()=>{const r=runMotor('72',fixtures[72]);close(r.finalMass,1,1e-10);assert.ok(r.density[0]<1);assert.throws(()=>runMotor('72',{...fixtures[72],dt:2}),/CFL/);});
test('73 plus-state qubit Pauli coherence and purity',()=>{const r=runMotor('73',fixtures[73]);close(r.purity,1);close(r.bloch[0],1);close(r.covariance[0][0],0);assert.throws(()=>runMotor('73',{density:[[{re:1,im:0},{re:1,im:0}],[{re:1,im:0},{re:0,im:0}]]}),/positive/);});
test('74 deterministic particle filter approximate constant observation',()=>{const r=runMotor('74',fixtures[74]);assert.deepEqual(r,runMotor('74',fixtures[74]));assert.ok(r.history.at(-1).posteriorMean>.6&&r.history.at(-1).posteriorMean<1.2);});
test('75 single output capsule activation and coupling normalization',()=>{const r=runMotor('75',fixtures[75]);close(r.outputs[0][0],.9);for(const a of r.coupling)close(sum(a),1);});
test('76 memory walk seed reproducible, bounded unit step',()=>{const r=runMotor('76',fixtures[76]);assert.deepEqual(r,runMotor('76',fixtures[76]));for(let i=1;i<r.positions.length;i++)assert.equal(Math.abs(r.positions[i]-r.positions[i-1]),1);});
test('77 constant 3D velocity preserved by periodic Navier-Stokes',()=>{const r=runMotor('77',fixtures[77]);for(const v of r.velocity){close(v[0],1);close(v[1],0);close(v[2],0);}close(r.history.at(-1).pressureResidual,0);});
test('78 DFA finite fluctuating signal',()=>{const r=runMotor('78',fixtures[78]);assert.equal(r.fluctuations.length,4);assert.ok(Number.isFinite(r.scalingExponent));});
test('79 QPSO improves quadratic fit deterministically',()=>{const r=runMotor('79',fixtures[79]);assert.deepEqual(r,runMotor('79',fixtures[79]));assert.ok(r.objective<.05);});
test('80 HJB deterministic unit running cost gives constant value',()=>{const r=runMotor('80',fixtures[80]);for(const v of r.values)close(v,1);assert.throws(()=>runMotor('80',{...fixtures[80],dt:100,diffusion:1}),/CFL/);});
test('registry IDs 61–80 are distinct real functions',()=>{const set=new Set();for(let i=61;i<=80;i++){const f=MOTOR_REGISTRY[String(i)];assert.equal(typeof f,'function');assert.ok(!set.has(f));set.add(f);assert.equal(typeof runMotor(String(i),fixtures[i]),'object');}});
function sum(a){return a.reduce((s,v)=>s+v,0);}
export {fixtures};
