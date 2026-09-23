import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';import {spawnSync} from 'node:child_process';import {readFileSync} from 'node:fs';
import {runMotor,MOTOR_REGISTRY} from '../src/index.mjs';
import {proveDiscreteLogRelation,verifyDiscreteLogRelation} from '../src/motors/zk-relation.mjs';
import {certifyStateInvariant,verifyStateInvariantSignature} from '../src/motors/invariance-signature.mjs';
const close=(x,y,tol=1e-7)=>assert.ok(Math.abs(x-y)<=tol,`${x} != ${y}`);
const cases={
41:{transition:[[.5,.5],[.5,.5]],steps:300},
42:{A:[[.5,0],[0,.25]]},
43:{replicas:['a','b','c','d'],faults:1,messages:['a','b','c'].flatMap(replica=>['PREPARE','COMMIT'].map(phase=>({replica,phase,value:'one'})))},
44:{p:[.5,.5],q:[1,0]},
45:{statement:{group:{p:'23',q:'11',g:'2'},y:'8',context:'job'},proof:{t:'1',z:'0'}},
46:{F:[[1]],H:[[1]],Q:[[.1]],R:[[1]],initialMean:[0],initialCov:[[1]],observations:[[1],null]},
47:{prior:[.5,.5],feature:[0,1],target:.8},
48:{parameters:[2,4],initial:.371,transient:250,samples:256},
49:{unary:[[0,0],[0,0]],transition:[[0,0],[0,0]]},
50:{certificate:{statement:{},signature:'',algorithm:'Ed25519'},publicKey:'',before:{},after:{},context:'job',epoch:0},
51:{field:[0,Math.atanh(.5)],couplings:[[0,0],[0,0]]},
52:{initial:[.2,.3,.4],r:4,coupling:0,steps:100,sampleEvery:20},
53:{p:[.25,.75]},
54:{initialAngle:3.13,initialVariance:1,processVariance:0,measurementVariance:.01,angularVelocity:0,dt:1,measurements:[-3.13]},
55:{features:[[1],[2]],edges:[[0,1]],weights:[[1]],activation:'identity'},
56:{initial:[1,0,0],diffusivity:1,dt:.1,dx:1,noise:0,steps:10},
57:{initial:[.7,.3],transitions:[[[1,0],[0,1]],[[0,1],[1,0]]],costs:[[0,1],[0,1]],congestion:[0,0],horizon:3},
58:{observations:Array.from({length:10},(_,i)=>[Math.tanh((i-5)/4),Math.sin(i)+.3*((i-5)/4)**2]),alpha:.3},
59:{bounds:[[0,1]],observations:[{x:[0],y:1},{x:[1],y:0}],candidates:[[0],[.25],[.5],[.75],[1]],noise:.01},
60:{a:0,b:1,q:1,r:1,terminal:0,horizon:1,steps:200,noise:.2}
};
cases[45]=JSON.parse(readFileSync(new URL('../examples/motor-45.json',import.meta.url)));
cases[50]=JSON.parse(readFileSync(new URL('../examples/motor-50.json',import.meta.url)));
test('41 irreducibility, aperiodicity, recurrent cycles and periodic counterexample',()=>{const r=runMotor('41',cases[41]);assert.equal(r.ergodic,true);close(r.cesaroEstimate[0],.5);const cycle=runMotor('41',{transition:[[0,1],[1,0]]});assert.equal(cycle.ergodic,false);assert.equal(cycle.recurrentClasses[0].period,2);});
test('41 malformed stochastic rows rejected',()=>assert.throws(()=>runMotor('41',{transition:[[.5,.4],[.5,.5]]}),/sum/));
test('42 diagonal linear stability and unstable pole',()=>{let r=runMotor('42',cases[42]);assert.equal(r.asymptoticallyStable,true);close(r.spectralRadius,.5);close(r.lyapunovCandidate[0][0],4/3,1e-6);assert.equal(runMotor('42',{A:[[1.1]]}).asymptoticallyStable,false);});
test('42 rejects matrices beyond its proved 2x2 scope',()=>assert.throws(()=>runMotor('42',{A:[[1,0,0],[0,1,0],[0,0,1]]}),/1..2/));
test('43 quorum certificate, equivocation and no counterfeit quorum',()=>{const r=runMotor('43',cases[43]);assert.equal(r.certificate.value,'one');const m=[...cases[43].messages,{replica:'a',phase:'PREPARE',value:'two'}];assert.equal(runMotor('43',{...cases[43],messages:m}).certificate,null);});
test('43 surplus replicas require n-f quorum to avoid disjoint conflicting certificates',()=>{const base={replicas:['a','b','c','d'],faults:0,messages:[{replica:'a',phase:'PREPARE',value:'one'},{replica:'a',phase:'COMMIT',value:'one'}]};const r=runMotor('43',base);assert.equal(r.quorum,4);assert.equal(r.certificate,null);});
test('43 Byzantine quorum bound enforced',()=>assert.throws(()=>runMotor('43',{...cases[43],faults:2}),/3f/));
test('44 Fisher distance, symmetry and positive metric',()=>{const r=runMotor('44',cases[44]);close(r.distance,Math.PI/2);close(r.metricChart[0][0],4);close(runMotor('44',{p:cases[44].q,q:cases[44].p}).distance,r.distance);});
test('44 distribution sum checked',()=>assert.throws(()=>runMotor('44',{p:[.5,.4],q:[.5,.5]}),/sum/));
test('45 Schnorr proof challenge binding, nonce randomization and witness privacy',()=>{const group={id:'MODP14-QR'};const a=proveDiscreteLogRelation({group,witness:'3',context:'job'});assert.equal(verifyDiscreteLogRelation(a).verified,true);assert.equal(verifyDiscreteLogRelation({...a,statement:{...a.statement,context:'tampered'}}).verified,false);assert.equal(Object.hasOwn(a,'witness'),false);assert.equal(runMotor('45',a).verified,true);});
test('45 malformed group or relation rejected',()=>assert.throws(()=>proveDiscreteLogRelation({group:{id:'UNKNOWN'},witness:'3',context:'job'}),/unsupported group/));
test('46 one-dimensional analytic gain and two-step Cholesky factor',()=>{const r=runMotor('46',cases[46]);close(r.history[0].mean[0],1.1/2.1);close(r.history[0].sqrtCov[0][0]**2,1.1/2.1);assert.equal(r.history[1].innovation,null);});
test('46 singular observation covariance and malformed rows rejected',()=>assert.throws(()=>runMotor('46',{...cases[46],R:[[0]]}),/positive definite/));
test('47 categorical KL-projection matches exact moment and handles boundary',()=>{const r=runMotor('47',cases[47]);assert.equal(r.status,'CONVERGED');close(r.posterior[1],.8);close(r.kl,.8*Math.log(1.6)+.2*Math.log(.4));});
test('47 out-of-hull expected feature rejected',()=>assert.throws(()=>runMotor('47',{...cases[47],target:2}),/invalid/));
test('48 logistic map analytic fixed point and chaotic finite-time indication',()=>{const r=runMotor('48',cases[48]);close(r.results[0].orbitTail.at(-1),.5);assert.ok(r.results[0].lyapunovEstimate<0);assert.ok(r.results[1].lyapunovEstimate>0);});
test('48 invalid logistic parameter rejected',()=>assert.throws(()=>runMotor('48',{parameters:[5]}),/invalid/));
test('49 exact CRF partition, uniform marginals and Viterbi',()=>{const r=runMotor('49',cases[49]);close(r.logPartition,Math.log(4));for(const row of r.marginals){close(row[0],.5);close(row.reduce((a,b)=>a+b,0),1);}assert.deepEqual(r.mapPath,[0,0]);});
test('49 non-finite potential rejected',()=>assert.throws(()=>runMotor('49',{...cases[49],unary:[[NaN,0]]}),/finite/));
test('50 signature covers before/after states, nonce and invariant keys',()=>{const {privateKey,publicKey}=generateKeyPairSync('ed25519'),privatePem=privateKey.export({format:'pem',type:'pkcs8'}),publicPem=publicKey.export({format:'pem',type:'spki'}),before={safe:true,count:1},after={safe:true,count:2},input={before,after,invariantKeys:['safe'],context:'job',epoch:7};const cert=certifyStateInvariant(input,privatePem);assert.equal(verifyStateInvariantSignature(cert,publicPem,before,after,'job',7).verified,true);assert.equal(verifyStateInvariantSignature(cert,publicPem,before,after,'job',8).verified,false);assert.equal(verifyStateInvariantSignature(cert,publicPem,before,{...after,count:3},'job',7).verified,false);assert.equal(runMotor('50',{certificate:cert,publicKey:publicPem,before,after,context:'job',epoch:7}).verified,true);});
test('50 changed invariant cannot be signed',()=>assert.throws(()=>certifyStateInvariant({before:{safe:true},after:{safe:false},invariantKeys:['safe'],context:'job',epoch:0},generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'})),/invariant changed/));
test('51 uncoupled Ising mean-field agrees with tanh analytic solution',()=>{const r=runMotor('51',cases[51]);close(r.means[0],0);close(r.means[1],.5);assert.equal(r.converged,true);});
test('51 asymmetric couplings rejected',()=>assert.throws(()=>runMotor('51',{field:[0,0],couplings:[[0,1],[0,0]]}),/symmetric/));
test('52 coupled lattice reproducible and uncoupled evolution agrees with logistic map',()=>{const r=runMotor('52',cases[52]);assert.deepEqual(r,runMotor('52',cases[52]));let x=.2;for(let i=0;i<100;i++)x=4*x*(1-x);close(r.final[0],x);});
test('52 invalid coupling rejected',()=>assert.throws(()=>runMotor('52',{...cases[52],coupling:1.1}),/invalid/));
test('53 categorical 1D Ricci zero, 2D constant sectional curvature',()=>{const a=runMotor('53',cases[53]),b=runMotor('53',{p:[1/3,1/3,1/3]});close(a.scalarCurvature,0);close(a.ricci[0][0],0);close(b.scalarCurvature,.5);close(b.ricci[0][0],b.metric[0][0]/4);});
test('53 boundary of simplex rejected',()=>assert.throws(()=>runMotor('53',{p:[0,1]}),/invalid/));
test('54 SO2 innovation uses wrapped shortest rotation',()=>{const r=runMotor('54',cases[54]);assert.ok(Math.abs(r.history[0].innovation)<.04);assert.ok(Math.abs(r.finalAngle)>3);});
test('54 zero measurement variance rejected',()=>assert.throws(()=>runMotor('54',{...cases[54],measurementVariance:0}),/invalid/));
test('55 normalized graph convolution includes loops and neighbor',()=>{const r=runMotor('55',cases[55]);close(r.values[0][0],1.5);close(r.values[1][0],1.5);});
test('55 duplicate adjacency rejected',()=>assert.throws(()=>runMotor('55',{...cases[55],edges:[[0,1],[1,0]]}),/duplicate/));
test('56 zero-noise SPDE conserves periodic-grid total mass',()=>{const r=runMotor('56',cases[56]);close(r.massFinal,1);assert.deepEqual(r,runMotor('56',cases[56]));});
test('56 unstable explicit heat scheme rejected',()=>assert.throws(()=>runMotor('56',{...cases[56],dt:1}),/stability/));
test('57 mean-field game converges for unambiguous stay policy',()=>{const r=runMotor('57',cases[57]);assert.equal(r.status,'CONVERGED');close(r.distribution[3][0],.7);assert.deepEqual(r.policy,[[0,0],[0,0],[0,0]]);});
test('57 invalid transition probabilities rejected',()=>assert.throws(()=>runMotor('57',{...cases[57],transitions:[[[.5,.4],[0,1]],...cases[57].transitions.slice(1)]}),/sum/));
test('58 known nonlinear mixing accurately recovers sources',()=>{const r=runMotor('58',cases[58]);close(r.reconstructionMaxError,0,1e-12);close(r.sources[0][0],-1.25);});
test('58 noninvertible tanh observation rejected',()=>assert.throws(()=>runMotor('58',{...cases[58],observations:Array.from({length:8},()=>[1,0])}),/strictly inside/));
test('59 GP posterior positive and EI candidate inside box',()=>{const r=runMotor('59',cases[59]);assert.ok(r.recommended.expectedImprovement>=0);assert.ok(r.recommended.x[0]>=0&&r.recommended.x[0]<=1);assert.deepEqual(r,runMotor('59',cases[59]));});
test('59 candidate outside box rejected',()=>assert.throws(()=>runMotor('59',{...cases[59],candidates:[[2]]}),/outside bounds/));
test('60 scalar stochastic LQR Riccati matches closed form tanh(1)',()=>{const r=runMotor('60',cases[60]);close(r.initialRiccati,Math.tanh(1),1e-9);close(r.initialGain,r.initialRiccati);assert.ok(r.noiseValueOffset>0);});
test('60 LQR rejects nonpositive quadratic control cost',()=>assert.throws(()=>runMotor('60',{...cases[60],r:0}),/invalid/));
test('registry has distinct executable functions for all twenty IDs 41–60',()=>{const names=new Set();for(let id=41;id<=60;id++){const fn=MOTOR_REGISTRY[id];assert.equal(typeof fn,'function');assert.ok(!names.has(fn));names.add(fn);assert.equal(typeof runMotor(String(id),cases[id]),'object');}});
test('CLI can execute JSON fixtures for all 20 new motors without network',()=>{for(let id=41;id<=60;id++){const filename=new URL(`../examples/motor-${id}.json`,import.meta.url);const spec=JSON.parse(readFileSync(filename));const child=spawnSync(process.execPath,['cli.mjs','motor',new URL(filename).pathname,String(id)],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:20000});assert.equal(child.status,0,`${id}: ${child.stderr}`);assert.equal(typeof JSON.parse(child.stdout),'object');assert.deepEqual(spec,cases[id]);}});
export {cases};
test('43 n=7 f=1 needs six distinct PREPARE and COMMIT votes',()=>{const replicas=['a','b','c','d','e','f','g'];const messages=replicas.slice(0,5).flatMap(replica=>['PREPARE','COMMIT'].map(phase=>({replica,phase,value:'v'})));const r=runMotor('43',{replicas,faults:1,messages});assert.equal(r.quorum,6);assert.equal(r.certificate,null);const full=runMotor('43',{replicas,faults:1,messages:[...messages,...['PREPARE','COMMIT'].map(phase=>({replica:'f',phase,value:'v'}))]});assert.equal(full.certificate.count,6);});
test('46 2D diagonal model equals independent analytic scalar filters',()=>{const r=runMotor('46',{F:[[1,0],[0,1]],H:[[1,0],[0,1]],Q:[[.1,0],[0,.2]],R:[[1,0],[0,2]],initialMean:[0,0],initialCov:[[1,0],[0,1]],observations:[[1,2]]});close(r.finalMean[0],1.1/2.1);close(r.finalMean[1],(1.2/3.2)*2);close(r.finalSqrtCov[0][0]**2,1.1/2.1);close(r.finalSqrtCov[1][1]**2,1.2*2/3.2);});
test('49 forward partition agrees with independently enumerated three-step paths',()=>{const input={unary:[[.4,-.2],[-.1,.8],[1,0]],transition:[[.1,.6],[-.4,.2]],start:[.3,0],end:[.1,-.2]};let z=0,best=-Infinity,bestPath;for(let a=0;a<2;a++)for(let b=0;b<2;b++)for(let c=0;c<2;c++){const v=input.start[a]+input.unary[0][a]+input.transition[a][b]+input.unary[1][b]+input.transition[b][c]+input.unary[2][c]+input.end[c];z+=Math.exp(v);if(v>best){best=v;bestPath=[a,b,c];}}const r=runMotor('49',input);close(r.logPartition,Math.log(z));assert.deepEqual(r.mapPath,bestPath);close(r.mapLogScore,best);});
test('55 graph convolution is equivariant to reordering of node IDs',()=>{const spec={features:[[1,2],[3,4],[5,6]],edges:[[0,1],[1,2]],weights:[[1,2],[2,1]],activation:'identity'},out=runMotor('55',spec);const permutation=[2,0,1],inv=Array.from({length:3},(_,i)=>permutation.indexOf(i)),permuted={...spec,features:permutation.map(i=>spec.features[i]),edges:spec.edges.map(([a,b])=>[inv[a],inv[b]])};const other=runMotor('55',permuted);for(let i=0;i<3;i++)for(let j=0;j<2;j++)close(other.values[i][j],out.values[permutation[i]][j]);});
test('56 seeded nonzero SPDE noise gives reproducible but non-conserved realized mass',()=>{const input={...cases[56],noise:0.2,seed:42};const a=runMotor('56',input),b=runMotor('56',input);assert.deepEqual(a,b);assert.ok(Math.abs(a.massFinal-a.massInitial)>1e-6);assert.notDeepEqual(a,runMotor('56',{...input,seed:43}));});
test('49 → 44 → 53: CRF marginals form a valid Fisher simplex with matching metric',()=>{const crf=runMotor('49',cases[49]),p=crf.marginals[0],geometry=runMotor('44',{p,q:crf.marginals[1]}),ricci=runMotor('53',{p});close(geometry.distance,0);close(geometry.metricChart[0][0],ricci.metric[0][0]);});
test('43 → 50: sign quorum metadata without claiming truth of untrusted votes',()=>{const quorum=runMotor('43',cases[43]),{privateKey,publicKey}=generateKeyPairSync('ed25519'),before={quorum:quorum.certificate,phase:'prepare'},after={quorum:quorum.certificate,phase:'commit'};const cert=certifyStateInvariant({before,after,invariantKeys:['quorum'],context:'quorum-audit',epoch:1},privateKey.export({type:'pkcs8',format:'pem'}));assert.equal(verifyStateInvariantSignature(cert,publicKey.export({type:'spki',format:'pem'}),before,after,'quorum-audit',1).verified,true);assert.equal(verifyStateInvariantSignature(cert,publicKey.export({type:'spki',format:'pem'}),before,{...after,quorum:{value:'tampered'}},'quorum-audit',1).verified,false);});
