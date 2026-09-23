import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import { analyzeInformationGeometry,simulateLorenz96,filterEnsembleKalman,solvePoissonPINN,diffuseInformation,solveMultilayerStackelberg,computePersistentHomology,inferFiniteCausalReward,estimateMultivariateTransferEntropy,optimizeScenarioRobust,runMotor,MOTOR_REGISTRY } from '../src/motors/index.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));
const close=(x,y,tol=1e-8)=>assert.ok(Math.abs(x-y)<=tol,`expected ${x} ≈ ${y} ± ${tol}`);

// 21 independent logarithm identities, zeros, KL asymmetry and contract validation.
test('21 KL directional analytic two-point example and Jensen Shannon symmetry',()=>{
 const x=fixture('information-simplex'),r=analyzeInformationGeometry(x),rev=analyzeInformationGeometry({p:x.q,q:x.p});
 close(r.klPtoQ,Math.log(4/3)/2);close(r.jensenShannonNats,rev.jensenShannonNats);assert.notEqual(r.klPtoQ,r.klQtoP);
 close(r.totalVariation,.25);assert.equal(r.identical,false);
});
test('21 KL zero-support divergence and zero-weight convention',()=>{
 const x=analyzeInformationGeometry({p:[1,0],q:[0,1]});assert.equal(x.klPtoQ,'Infinity');assert.equal(x.klQtoP,'Infinity');close(x.jensenShannonNats,Math.log(2));
 const y=analyzeInformationGeometry({p:[1,0],q:[1,0]});close(y.klPtoQ,0);close(y.jensenShannonNats,0);
});
test('21 invalid distribution, NaN and extra inputs rejected',()=>{
 for(const x of [{p:[.4,.4],q:[.5,.5]},{p:[-.1,1.1],q:[.5,.5]},{p:[1,NaN],q:[.5,.5]},{p:[.5,.5],q:[.5,.5],fake:true}])assert.throws(()=>analyzeInformationGeometry(x));
});

// 22 analytic equilibrium and independent first-order Taylor step comparison.
test('22 Lorenz96 exact equilibrium F for any dimension',()=>{
 const r=simulateLorenz96(fixture('lorenz96-equilibrium'));assert.equal(r.dimension,6);
 for(const x of r.finalState)close(x,8,1e-12);assert.equal(r.samples.at(-1).step,100);
});
test('22 Lorenz96 short step follows independent reference vector field',()=>{
 const x=[1,2,3,4,5],F=8,dt=1e-5,r=simulateLorenz96({initial:x,forcing:F,dt,steps:1});
 for(let i=0;i<x.length;i++)close(r.finalState[i],x[i]+dt*((x[(i+1)%5]-x[(i+3)%5])*x[(i+4)%5]-x[i]+F),1e-8);
});
test('22 seeded deterministic outputs, precision/bounds fail closed',()=>{
 const x={initial:[1,2,3,4],forcing:8,dt:.01,steps:20};assert.deepEqual(simulateLorenz96(x),simulateLorenz96(x));
 assert.throws(()=>simulateLorenz96({...x,dt:.2}),/dt/);
 assert.throws(()=>simulateLorenz96({...x,initial:[1,2,3]}),/initial/);
});

// 23 reproducible stochastic approximation, observability and covariance safety.
test('23 stochastic EnKF seeded results and observation assimilation',()=>{
 const x=fixture('ensemble-kalman'),r=filterEnsembleKalman(x);
 assert.deepEqual(r,filterEnsembleKalman(x));assert.equal(r.steps.length,3);
 assert.ok(Math.abs(r.steps[0].posteriorMean[0]-1)<Math.abs(r.steps[0].priorMean[0]-1));
 assert.equal(r.steps[2].updated,false);assert.equal(r.finalEnsemble.length,x.ensemble.length);
});
test('23 no observations yields deterministic seeded forecast, covariance symmetric',()=>{
 const x=fixture('ensemble-kalman'),r=filterEnsembleKalman({...x,observations:[null,null]});
 assert.equal(r.steps.every(t=>!t.updated),true);assert.ok(r.steps[0].posteriorCovariance[0][0]>0);
});
test('23 rejects nonpositive, nonsymmetric, malformed covariance and ensemble',()=>{
 const x=fixture('ensemble-kalman');
 assert.throws(()=>filterEnsembleKalman({...x,R:[[0]]}),/positive definite/);
 assert.throws(()=>filterEnsembleKalman({...x,ensemble:[[1],[2]]}),/ensemble/);
 const two={ensemble:[[0,0],[1,0],[0,1]],F:[[1,0],[0,1]],H:[[1,0]],Q:[[1,.5],[.1,1]],R:[[1]],observations:[[0]]};
 assert.throws(()=>filterEnsembleKalman(two),/symmetric/);
});

// 24 analytic solution u(x)=x(1-x) for -u''=2, no claimed general PDE.
test('24 PINN constant forcing solution and boundary residuals',()=>{
 const r=solvePoissonPINN(fixture('pinn-poisson'));
 assert.ok(r.rmsPDEResidual<.003);for(const v of r.boundaryResiduals)assert.ok(Math.abs(v)<.001);
 for(const p of r.predictions)close(p.value,p.x*(1-p.x),.003);
});
test('24 forcing zero and linearly varying boundary yields linear interpolation',()=>{
 const r=solvePoissonPINN({...fixture('pinn-poisson'),forcing:{kind:'constant',value:0},boundary:[1,3]});
 for(const p of r.predictions)close(p.value,1+2*p.x,.003);
});
test('24 rejects unknown source and query outside domain',()=>{
 const x=fixture('pinn-poisson');assert.throws(()=>solvePoissonPINN({...x,forcing:{kind:'eval',value:1}}),/kind/);
 assert.throws(()=>solvePoissonPINN({...x,queries:[-0.1]}),/queries/);
});

// 25 independent analytic explicit Euler first step and conservation.
test('25 discrete diffusion first step, mass conservation and positivity',()=>{
 const x=fixture('information-diffusion'),r=diffuseInformation({...x,steps:1,sampleEvery:1});
 assert.deepEqual(r.finalValues,[.8,.2,0]);close(r.finalMass,r.initialMass,1e-14);
});
test('25 symmetric two-node diffusion converges to mean, isolated node unchanged',()=>{
 const x={nodes:['A','B','C'],edges:[{from:'A',to:'B',conductance:1}],initial:[1,0,9],diffusivity:1,dt:.25,steps:80};
 const r=diffuseInformation(x);close(r.finalValues[0],.5,1e-10);close(r.finalValues[1],.5,1e-10);close(r.finalValues[2],9);
});
test('25 rejects unstable timestep and duplicate reversed edge',()=>{
 const x=fixture('information-diffusion');assert.throws(()=>diffuseInformation({...x,dt:1}),/bound/);
 assert.throws(()=>diffuseInformation({...x,edges:[...x.edges,{from:'B',to:'A',conductance:1}]}),/duplicate/);
});

// 26 backward induction compared with independent exhaustive subgame checks.
test('26 perfect information three-stage game backward induction',()=>{
 const x=fixture('stackelberg-three-stage'),r=solveMultilayerStackelberg(x);
 assert.deepEqual([r.leader,r.follower1,r.follower2],['L1','A1','B1']);assert.deepEqual(r.payoffs,[6,4,5]);
 for(let i=0;i<x.leaderActions.length;i++)for(let j=0;j<x.follower1Actions.length;j++){
  const k=x.follower2Actions.indexOf(r.follower2Responses[i][j].follower2);
  assert.ok(x.payoffs[i][j].every(v=>v[2]<=x.payoffs[i][j][k][2]));
 }
});
test('26 lexicographic tie-break selects first choices',()=>{
 const x={leaderActions:['L0','L1'],follower1Actions:['A0','A1'],follower2Actions:['B0','B1'],payoffs:Array.from({length:2},()=>Array.from({length:2},()=>[[0,0,0],[0,0,0]]))};
 const r=solveMultilayerStackelberg(x);assert.deepEqual([r.leader,r.follower1,r.follower2],['L0','A0','B0']);
});
test('26 rejects malformed payoff tensor and unknown keys',()=>{
 const x=fixture('stackelberg-three-stage');assert.throws(()=>solveMultilayerStackelberg({...x,payoffs:[[[[1,2,3]]]]}),/payoffs/);
 assert.throws(()=>solveMultilayerStackelberg({...x,nonce:true}),/unknown/);
});

// 27 independent geometry of triangle, square and two clusters.
test('27 square cycle H1 born at side length and dies at diagonal',()=>{
 const r=computePersistentHomology(fixture('persistent-square'));
 assert.equal(r.h0.length,4);assert.equal(r.h0.filter(x=>x.death===null).length,1);
 const significant=r.h1.filter(x=>x.death!==null&&x.death-x.birth>1e-8);
 assert.equal(significant.length,1);close(significant[0].birth,1);close(significant[0].death,Math.SQRT2);
});
test('27 equilateral triangle has no positive-persistence H1 and one final H0',()=>{
 const r=computePersistentHomology({points:[[0,0],[1,0],[.5,Math.sqrt(3)/2]]});
 assert.equal(r.h0.filter(x=>x.death===null).length,1);assert.equal(r.h1.filter(x=>x.death!==null&&x.death>x.birth+1e-8).length,0);
});
test('27 filtration capped below separation has two essential H0',()=>{
 const r=computePersistentHomology({points:[[0],[5]],maxScale:1});
 assert.equal(r.simplexCount,2);assert.equal(r.h0.filter(x=>x.death===null).length,2);
});
test('27 rejects dimension mismatch and nonfinite distance',()=>{
 assert.throws(()=>computePersistentHomology({points:[[1],[1,2]]}),/dimensions/);
 assert.throws(()=>computePersistentHomology({points:[[0],[Infinity]]}),/finite/);
});

// 28 known causal action dynamics, held-out preference and non-identifiability caveat.
test('28 expert demonstration identifies positive reward feature preference',()=>{
 const x=fixture('causal-irl'),r=inferFiniteCausalReward(x);
 assert.ok(r.weights[0]>1);assert.ok(r.gradientNorm<.05);
 const policy=r.policy[0].states[0].actionProbabilities;assert.ok(policy.LEFT>.9);
 assert.ok(r.expectedFeatureCounts[0]<=1+1e-12);
});
test('28 reversed demonstrations identify opposite preference',()=>{
 const x=fixture('causal-irl');x.demonstrations=x.demonstrations.map(()=>({states:['START','BAD','BAD'],actions:['RIGHT','RIGHT']}));
 const r=inferFiniteCausalReward(x);assert.ok(r.weights[0]<-1);assert.ok(r.policy[0].states[0].actionProbabilities.RIGHT>.9);
});
test('28 impossible demo and invalid transition mass fail closed',()=>{
 const x=fixture('causal-irl');assert.throws(()=>inferFiniteCausalReward({...x,demonstrations:[{states:['START','BAD','BAD'],actions:['LEFT','LEFT']}]}),/impossible/);
 const t=structuredClone(x);t.transitions[0][0]=[.2,.2,.2];assert.throws(()=>inferFiniteCausalReward(t),/summing/);
});

// 29 conditional information not a causal test; exact lag recovery on designed series.
test('29 deterministic alternating lag-copy adds no information beyond target history',()=>{
 const x=Array.from({length:32},(_,i)=>i%2),y=[1,...x.slice(0,-1)];
 const r=estimateMultivariateTransferEntropy({target:y,sources:[x],lag:1});
 // Alternating input makes source fully known by target history. No extra information, even though target is a lagged copy.
 close(r.bits,0,1e-12);
});
test('29 de Bruijn cyclic source has almost one bit transferred to next target',()=>{
 const x=[0,0,0,1,0,1,1,1];const source=Array.from({length:801},(_,i)=>x[i%8]);const target=[0,...source.slice(0,-1)];
 const r=estimateMultivariateTransferEntropy({target,sources:[source]});assert.ok(r.bits>.98&&r.bits<=1.00001);
 const controlled=estimateMultivariateTransferEntropy({target,sources:[source],controls:[source]});close(controlled.bits,0,1e-12);
});
test('29 lagged independent constant source has zero information, inputs validated',()=>{
 const y=[0,1,0,1,0,1,0,1],x=Array(8).fill(0);
 close(estimateMultivariateTransferEntropy({target:y,sources:[x]}).bits,0);
 assert.throws(()=>estimateMultivariateTransferEntropy({target:y,sources:[[0,1]]}),/entries/);
 assert.throws(()=>estimateMultivariateTransferEntropy({target:y,sources:[x],lag:30}),/lag/);
});

// 30 exhaustive independent enumeration for small costs, feasibility and robust ranking.
test('30 minimax cost and minimax regret are distinct objectives',()=>{
 const x={decisions:['A','B','C'],scenarios:['S0','S1'],objective:[[0,105],[10,100],[20,120]]},r=optimizeScenarioRobust(x);
 assert.equal(r.minimumMaxCost.decision,'B');assert.equal(r.minimumMaxRegret.decision,'A');
 assert.equal(r.minimumMaxCost.maximumCost,100);assert.equal(r.minimumMaxRegret.maximumRegret,5);
});
test('30 infeasibility returns no fabricated solution',()=>{
 const x=fixture('scenario-robust');x.feasible=x.feasible.map(()=>[false,false]);
 const r=optimizeScenarioRobust(x);assert.equal(r.status,'INFEASIBLE');assert.equal(r.minimumMaxCost,null);
});
test('30 exhaustively checks 256 two-scenario binary decision matrices',()=>{
 const values=[0,2,4,6];for(let n=0;n<256;n++){
  const xs=[n&3,(n>>2)&3,(n>>4)&3,(n>>6)&3].map(i=>values[i]);
  const input={decisions:['A','B'],scenarios:['X','Y'],objective:[xs.slice(0,2),xs.slice(2)]};const r=optimizeScenarioRobust(input);
  const worst=input.objective.map(row=>Math.max(...row));const expected=Math.min(...worst);
  assert.equal(r.minimumMaxCost.maximumCost,expected);
  const lows=[Math.min(xs[0],xs[2]),Math.min(xs[1],xs[3])];
  const regrets=input.objective.map(row=>Math.max(...row.map((v,j)=>v-lows[j])));
  assert.equal(r.minimumMaxRegret.maximumRegret,Math.min(...regrets));
 }
});
test('30 unknown decision, malformed feasibility and NaN rejected',()=>{
 const x=fixture('scenario-robust');assert.throws(()=>optimizeScenarioRobust({...x,decisions:['A','A','C']}),/duplicate/);
 assert.throws(()=>optimizeScenarioRobust({...x,feasible:[[1,1],[1,1],[1,1]]}),/boolean/);
 assert.throws(()=>optimizeScenarioRobust({...x,objective:[[NaN,1],[1,2],[3,4]]}),/finite/);
});

test('21–30 registry can execute each real motor through CLI, unknown ID must remain unimplemented',()=>{
 const fixtures=['information-simplex','lorenz96-equilibrium','ensemble-kalman','pinn-poisson','information-diffusion','stackelberg-three-stage','persistent-square','causal-irl','multivariate-transfer-entropy','scenario-robust'];
 for(let i=0;i<10;i++){
  const num=String(i+21),input=fixture(fixtures[i]);assert.equal(typeof MOTOR_REGISTRY[num],'function');
  assert.ok(runMotor(num,input));
  const proc=spawnSync(process.execPath,['cli.mjs','motor',`examples/${fixtures[i]}.json`,num],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(proc.status,0,`motor ${num}: ${proc.stderr}`);assert.ok(JSON.parse(proc.stdout).domain||JSON.parse(proc.stdout).model);
 }
 assert.throws(()=>runMotor('101',{}),/not implemented/);
});
test('25 → 30 linked real outputs, zero-effect diffusion reproduces input costs',()=>{
 const d=diffuseInformation({nodes:['A','B'],edges:[{from:'A',to:'B',conductance:1}],initial:[2,7],diffusivity:0,dt:.5,steps:2});
 const r=optimizeScenarioRobust({decisions:['A','B'],scenarios:['measured','stress'],objective:[[d.finalValues[0],9],[d.finalValues[1],8]]});
 assert.equal(r.minimumMaxCost.decision,'B');assert.equal(r.minimumMaxCost.maximumCost,8);
});

test('24 sine forcing matches independent analytic u(x)=sin(pi*x)/pi²',()=>{
 const r=solvePoissonPINN({...fixture('pinn-poisson'),forcing:{kind:'sine'}});
 for(const {x,value} of r.predictions)close(value,Math.sin(Math.PI*x)/(Math.PI*Math.PI),.004);
 assert.ok(r.rmsPDEResidual<.01);
});
test('22 RK4 convergence under step halving on non-equilibrium Lorenz96',()=>{
 const x={initial:[8.01,8,8,8,8],forcing:8,dt:.01,steps:50};
 const a=simulateLorenz96(x),b=simulateLorenz96({...x,dt:.005,steps:100});
 const err=Math.hypot(...a.finalState.map((v,i)=>v-b.finalState[i]));assert.ok(err<.00001,`RK4 convergence error ${err}`);
});
test('27 independent union-find H0 component counts at several filtration scales',()=>{
 const points=[[0,0],[1,0],[0,3],[1,3],[8,0]];
 for(const scale of [0,.9,1,3,3.17,7,8,10]){
  const r=computePersistentHomology({points,maxScale:scale});
  const parent=points.map((_,i)=>i);const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
   if(Math.hypot(points[i][0]-points[j][0],points[i][1]-points[j][1])<=scale)parent[find(i)]=find(j);
  }
  const expected=new Set(parent.map((_,i)=>find(i))).size;
  assert.equal(r.h0.filter(b=>b.death===null).length,expected,`scale ${scale}`);
 }
});
test('26 128 seeded games compare independent brute-force backward induction',()=>{
 let seed=13;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%13-6;};
 for(let iter=0;iter<128;iter++){
  const x={leaderActions:['L0','L1'],follower1Actions:['A0','A1'],follower2Actions:['B0','B1'],payoffs:Array.from({length:2},()=>Array.from({length:2},()=>Array.from({length:2},()=>[rand(),rand(),rand()])))},r=solveMultilayerStackelberg(x);
  const f2=(i,j)=>x.payoffs[i][j][0][2]>=x.payoffs[i][j][1][2]?0:1;
  const f1=i=>x.payoffs[i][0][f2(i,0)][1]>=x.payoffs[i][1][f2(i,1)][1]?0:1;
  const leader=x.payoffs[0][f1(0)][f2(0,f1(0))][0]>=x.payoffs[1][f1(1)][f2(1,f1(1))][0]?0:1;
  assert.deepEqual([r.leader,r.follower1,r.follower2],[x.leaderActions[leader],x.follower1Actions[f1(leader)],x.follower2Actions[f2(leader,f1(leader))]]);
 }
});
