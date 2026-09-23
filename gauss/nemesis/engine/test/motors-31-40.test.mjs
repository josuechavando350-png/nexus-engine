import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
 runLocalContract,compileLocalContract,executeLocalContract,analyzeDynamicGraph,decomposeEmpiricalModes,
 filterDynamicBayes,solveStochasticDP,estimateConvergentCrossMap,sampleSpatiotemporalField,
 optimizeConstrainedSwarm,generatePaillierKeypair,paillierEncrypt,paillierAdd,paillierScale,paillierDecrypt,
 runPaillier,verifyInductiveInvariant,runMotor,MOTOR_REGISTRY
} from '../src/index.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));
const close=(x,y,tol=1e-8)=>assert.ok(Math.abs(x-y)<=tol,`expected ${x} ≈ ${y}`);

test('31 deterministic compiler applies matching rule and preserves unrelated registers',()=>{
 const x=fixture('local-contract'),r=runLocalContract(x);
 assert.equal(r.status,'APPLIED_IN_MEMORY');assert.deepEqual(r.state,{balance:9,nonce:0});
 assert.equal(compileLocalContract(x.contract).hash,compileLocalContract(x.contract).hash);
});
test('31 rejects failed guard, malicious bytecode and arithmetic overflow',()=>{
 const x=fixture('local-contract'),c=compileLocalContract(x.contract);
 assert.equal(executeLocalContract(c,{balance:1,nonce:0},'debit').status,'REJECTED');
 assert.throws(()=>executeLocalContract({...c,hash:'0'.repeat(64)},x.initial,'debit'),/tampered/);
 assert.throws(()=>executeLocalContract(c,{balance:1e9,nonce:0},'credit'),/result/);
 assert.throws(()=>compileLocalContract({...x.contract,rules:[{name:'bad',register:'balance',op:'EVAL',value:1,effect:{register:'balance',delta:1}}]}),/op/);
});
test('32 add/remove graph updates, connected components and shortest path',()=>{
 const r=analyzeDynamicGraph(fixture('dynamic-graph'));
 assert.equal(r.edgeCount,2);assert.equal(r.components.length,2);assert.equal(r.shortestPaths.C,2);assert.equal(r.shortestPaths.D,null);
});
test('32 rejects duplicate edges, missing removal and unknown vertices',()=>{
 const x=fixture('dynamic-graph');assert.throws(()=>analyzeDynamicGraph({...x,updates:[{kind:'remove',from:'A',to:'D'}]}),/removal/);
 assert.throws(()=>analyzeDynamicGraph({...x,edges:[...x.edges,x.edges[0]]}),/duplicate/);
 assert.throws(()=>analyzeDynamicGraph({...x,source:'Z'}),/source/);
});
test('33 EMD conserves samples via reconstruction and terminates linear trend',()=>{
 const x=fixture('empirical-mode'),r=decomposeEmpiricalModes(x);
 assert.ok(r.modes.length>=1);assert.ok(r.maxReconstructionError<1e-9);
 const y=decomposeEmpiricalModes({signal:[0,1,2,3,4,5,6]});assert.equal(y.modes.length,0);assert.deepEqual(y.residual,[0,1,2,3,4,5,6]);
});
test('33 EMD rejects bad lengths and nonfinite signals',()=>{
 assert.throws(()=>decomposeEmpiricalModes({signal:[1,2,3]}),/signal/);
 assert.throws(()=>decomposeEmpiricalModes({signal:[0,1,2,NaN,4]}),/finite/);
});
test('34 binary DBN forward posterior matches hand calculation and normalizes',()=>{
 const x=fixture('dynamic-bayes'),r=filterDynamicBayes({...x,observations:[0,1]});
 close(r.posterior[0][0],1);close(r.posterior[1][1],.09/(.18+.09));
 for(const p of r.posterior)close(p.reduce((a,b)=>a+b,0),1);
});
test('34 DBN rejects zero evidence and stochastic row errors',()=>{
 const x=fixture('dynamic-bayes');assert.throws(()=>filterDynamicBayes({...x,transition:[[.2,.2],[.2,.8]]}),/sum/);
 assert.throws(()=>filterDynamicBayes({...x,emission:[[1,0],[1,0]],observations:[1]}),/zero/);
});
test('35 Bellman recursion recovers exact finite horizon policy',()=>{
 const r=solveStochasticDP(fixture('stochastic-dp'));
 assert.deepEqual(r.policies,[['stay','switch'],['stay','switch']]);
 close(r.values[1][0],2);close(r.values[0][0],4);close(r.values[0][1],4);
});
test('35 horizon and transition probabilities validated',()=>{
 const x=fixture('stochastic-dp');assert.throws(()=>solveStochasticDP({...x,horizon:0}),/horizon/);
 assert.throws(()=>solveStochasticDP({...x,transitions:[[[1,1],[0,1]],...x.transitions.slice(1)]}),/sum|entries/);
});
test('36 cross map produces finite out-of-sample prediction skill',()=>{
 const r=estimateConvergentCrossMap(fixture('cross-map'));
 assert.equal(r.skills.length,2);for(const s of r.skills){assert.ok(s.meanSquaredError>=0);assert.ok(s.queryCount>1);assert.ok(s.correlation===null||Math.abs(s.correlation)<=1+1e-9);}
});
test('36 cross map rejects short and mismatched input',()=>{
 const x=fixture('cross-map');assert.throws(()=>estimateConvergentCrossMap({...x,y:x.y.slice(1)}),/length/);
 assert.throws(()=>estimateConvergentCrossMap({...x,delay:100}),/delay|few/);
});
test('37 Gaussian field seeded covariance and sample deterministic',()=>{
 const x=fixture('spatiotemporal-field'),a=sampleSpatiotemporalField(x),b=sampleSpatiotemporalField(x);
 assert.deepEqual(a,b);close(a.covariance[0][0],x.variance+(x.nugget??0));
 close(a.covariance[0][1],a.covariance[1][0]);assert.equal(a.sample.length,x.points.length);
});
test('37 duplicate points without nugget rejected, positive nugget accepted',()=>{
 const x=fixture('spatiotemporal-field'),p=x.points[0];assert.throws(()=>sampleSpatiotemporalField({...x,points:[p,p],nugget:0}),/positive definite/);
 assert.equal(sampleSpatiotemporalField({...x,points:[p,p],nugget:.001}).sample.length,2);
});
test('38 quadratic swarm returns feasible candidate respecting bounds and inequalities',()=>{
 const x=fixture('constrained-swarm'),r=optimizeConstrainedSwarm(x);
 assert.equal(r.status,'FEASIBLE_CANDIDATE');assert.ok(r.bestPoint[0]+r.bestPoint[1]<=1+1e-10);
 assert.ok(r.bestCost<1);assert.deepEqual(r,optimizeConstrainedSwarm(x));
});
test('38 swarm reports no candidate without fabricating infeasibility proof',()=>{
 const x=fixture('constrained-swarm');const r=optimizeConstrainedSwarm({...x,constraints:[{coefficients:[0,0],max:-1}]});
 assert.equal(r.status,'NO_FEASIBLE_CANDIDATE_FOUND');assert.equal(r.bestPoint,null);
 assert.throws(()=>optimizeConstrainedSwarm({...x,bounds:[[1,0],[0,1]]}),/bounds/);
});
test('39 Paillier fresh randomized encryptions and modular additive identity',()=>{
 const {publicKey,privateKey}=generatePaillierKeypair();const a=paillierEncrypt(publicKey,'9'),b=paillierEncrypt(publicKey,'13');
 assert.notEqual(a,paillierEncrypt(publicKey,'9'));assert.equal(paillierDecrypt(privateKey,a),'9');
 assert.equal(paillierDecrypt(privateKey,paillierAdd(publicKey,a,b)),'22');
 assert.equal(paillierDecrypt(privateKey,paillierScale(publicKey,a,'3')),'27');
 assert.equal(runPaillier({publicKey,message:'9'}).domain,'PAILLIER_ADDITIVE_ONLY');
});
test('39 Paillier rejects malformed ciphertext, out-of-range messages and fabricated modulus',()=>{
 const {publicKey,privateKey}=generatePaillierKeypair();assert.throws(()=>paillierEncrypt(publicKey,publicKey.n),/plaintext/);
 assert.throws(()=>paillierDecrypt(privateKey,'0'),/ciphertext/);
 assert.throws(()=>paillierEncrypt({n:'15'},'1'),/modulus/);
});
test('40 inductive proof over all valuations and reachable-state witness',()=>{
 const x=fixture('invariant-safe'),r=verifyInductiveInvariant(x);
 assert.equal(r.initiated,true);assert.equal(r.inductive,true);assert.equal(r.provenByInduction,true);assert.equal(r.reachableInvariantHolds,true);
 const bad=verifyInductiveInvariant({...x,rules:[...x.rules,{name:'break',guard:[],assign:[{variable:'safe',equals:false}]}]});
 assert.equal(bad.provenByInduction,false);assert.equal(bad.reachableInvariantHolds,false);assert.equal(bad.witness.at(-1).via,'break');
});
test('40 noninductive invariant can hold on all reachable states; rejects invalid DSL',()=>{
 const x=fixture('invariant-safe'),r=verifyInductiveInvariant({...x,rules:[{name:'hidden',guard:[{variable:'ready',equals:true}],assign:[{variable:'safe',equals:false}]}]});
 assert.equal(r.inductive,false);assert.equal(r.reachableInvariantHolds,true);assert.equal(r.provenByInduction,false);
 assert.throws(()=>verifyInductiveInvariant({...x,variables:['safe','safe']}),/duplicates/);
});
test('registry 31..40 CLI routes to actual implementations',()=>{
 const names=['local-contract','dynamic-graph','empirical-mode','dynamic-bayes','stochastic-dp','cross-map','spatiotemporal-field','constrained-swarm','paillier-public','invariant-safe'];
 for(let i=0;i<10;i++){const id=String(i+31);assert.equal(typeof MOTOR_REGISTRY[id],'function');const input=fixture(names[i]);
  const response=runMotor(id,input);assert.equal(typeof response,'object');
  if(id!=='39'){const child=spawnSync(process.execPath,['cli.mjs','motor',`examples/${names[i]}.json`,id],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(child.status,0,`${id}: ${child.stderr}`);}
 }
});

test('31 compiled contracts are Ed25519-signed and reject modified artifacts and signatures',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const keys=generateKeyPairSync('ed25519'),spec=fixture('local-contract'),c=compileLocalContract(spec.contract);
 const {signLocalContract,verifyLocalContractSignature}=await import('../src/index.mjs');
 const signature=signLocalContract(c,keys.privateKey.export({type:'pkcs8',format:'pem'}));
 const publicKey=keys.publicKey.export({type:'spki',format:'pem'});
 assert.equal(verifyLocalContractSignature(c,signature,publicKey),true);
 assert.equal(verifyLocalContractSignature(c,Buffer.alloc(64).toString('base64'),publicKey),false);
 const other=compileLocalContract({...spec.contract,rules:spec.contract.rules.map((r,i)=>i? r:{...r,value:4})});
 assert.equal(verifyLocalContractSignature(other,signature,publicKey),false);
 assert.throws(()=>signLocalContract({...c,hash:'f'.repeat(64)},keys.privateKey.export({type:'pkcs8',format:'pem'})),/tampered/);
});

test('32 BFS distances agree with independent Floyd-Warshall on all 64 undirected four-node graphs',()=>{
 const names=['A','B','C','D'],pairs=[];for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)pairs.push([i,j]);
 for(let bits=0;bits<64;bits++){
  const edges=pairs.filter((_,k)=>bits&(1<<k)).map(([a,b])=>({from:names[a],to:names[b]}));
  const r=analyzeDynamicGraph({vertices:names,edges,updates:[],source:'A'}),dist=Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>i===j?0:Infinity));
  for(const [i,j] of pairs.filter((_,k)=>bits&(1<<k))){dist[i][j]=1;dist[j][i]=1;}
  for(let k=0;k<4;k++)for(let i=0;i<4;i++)for(let j=0;j<4;j++)dist[i][j]=Math.min(dist[i][j],dist[i][k]+dist[k][j]);
  for(let i=0;i<4;i++)assert.equal(r.shortestPaths[names[i]],Number.isFinite(dist[0][i])?dist[0][i]:null);
 }
});

test('35 dynamic programming matches independent brute-force recursive Bellman oracle',()=>{
 const x=fixture('stochastic-dp');for(let horizon=1;horizon<=7;horizon++){
  const r=solveStochasticDP({...x,horizon});
  function oracle(t,s){if(t===horizon)return 0;return Math.max(...x.actions.map((_,a)=>x.rewards[s][a]+x.transitions[s][a].reduce((sum,p,j)=>sum+p*oracle(t+1,j),0)));}
  for(let s=0;s<2;s++)close(r.values[0][s],oracle(0,s));
 }
});

test('39 modulo-n homomorphism wraps naturally, not ordinary unbounded integer addition',()=>{
 const {publicKey,privateKey}=generatePaillierKeypair();const m=(BigInt(publicKey.n)-1n).toString();
 const a=paillierEncrypt(publicKey,m),b=paillierEncrypt(publicKey,'2');
 assert.equal(paillierDecrypt(privateKey,paillierAdd(publicKey,a,b)),'1');
 assert.throws(()=>paillierScale(publicKey,a,'1000001'),/scalar/);
 const child=spawnSync(process.execPath,['cli.mjs','motor','examples/paillier-public.json','39'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);const output=JSON.parse(child.stdout);assert.equal(typeof output.ciphertext,'string');assert.equal(Object.hasOwn(output,'privateKey'),false);
});

test('40 all 16 Boolean valuations agree with independent exhaustive induction oracle',()=>{
 const variables=['a','b','c','d'],invariant=[{variable:'a',equals:true}],base={variables,initial:[true,false,false,false],invariant,rules:[]};
 for(let mask=0;mask<16;mask++){
  const guard=variables.map((variable,i)=>({variable,equals:Boolean(mask&(1<<i))}));
  const input={...base,rules:[{name:'flip',guard,assign:[{variable:'a',equals:false}]}]};
  const r=verifyInductiveInvariant(input);assert.equal(r.inductive,Boolean(!(mask&1)));
 }
});
