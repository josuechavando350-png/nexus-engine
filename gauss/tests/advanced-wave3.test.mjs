import assert from 'node:assert/strict';
import test from 'node:test';
import { inferHiddenMarkov } from '../advanced/hidden-markov.mjs';
import { simulateCoinedQuantumWalk } from '../advanced/quantum-walk.mjs';
import { filterVectorKalman } from '../advanced/kalman-vector.mjs';
import { synchronizeClockIntervals } from '../advanced/chronos.mjs';
import { reduceIntervalType2 } from '../advanced/type2-fuzzy.mjs';
import { executeGaussAdvancedProblem } from '../advanced/index.mjs';

const num = s => { const [n,d] = s.split('/').map(Number); return n / d; };
const near = (a,b,eps=1e-10) => assert(Math.abs(a-b) < eps, `${a} is not near ${b}`);
const hmm = { initialTrue:'1/2', transition:[['3/4','1/4'],['1/4','3/4']], emission:[['3/4','1/4'],['1/4','3/4']], observations:[1,0,1] };
const walk = { sites:7, steps:4, initialSite:0, coinState:[1,0,0,0] };
const kalman = {transition:[[1,1],[0,1]],processCovariance:[[0,0],[0,0]],measurementVector:[1,0],
  measurementVariance:1,initialMean:[0,0],initialCovariance:[[1,0],[0,1]],observations:[1,2,null,3]};
const chronos = {exchanges:[{t1:0,t2:12,t3:13,t4:5},{t1:20,t2:32,t3:34,t4:26}]};

test('HMM exact forward backward and Viterbi: posterior and exact evidence', () => {
  const simple = inferHiddenMarkov({...hmm, transition:[['1/1','0/1'],['0/1','1/1']], observations:[1,1]});
  assert.equal(simple.observationLikelihood,'5/16');
  assert.equal(simple.posteriorTrue,'9/10');
  assert.deepEqual(simple.filteredPosteriorHistoryTrue,['3/4','9/10']);
  assert.deepEqual(simple.smoothedPosteriorHistoryTrue,['9/10','9/10']);
  assert.deepEqual(simple.viterbiPath,[1,1]);
});

test('HMM exhaustive independent path enumeration: 20 deterministic models', () => {
  for (let trial=0;trial<20;trial++) {
    const x={...hmm,initialTrue:`${trial%7+1}/10`,observations:Array.from({length:4},(_,j)=>(trial+j)%2),
      transition:[ [`${(trial%5)+3}/10`,`${7-trial%5}/10`], ['2/5','3/5'] ]};
    const r=inferHiddenMarkov(x);
    const p=[1-num(x.initialTrue),num(x.initialTrue)],T=x.transition.map(row=>row.map(num)),E=x.emission.map(row=>row.map(num));
    let likelihood=0, finalTrue=0, max=-1, best=null, maxCount=0;
    for(let mask=0;mask<16;mask++) {
      const path=Array.from({length:4},(_,t)=>(mask>>t)&1);
      let m=p[path[0]]*E[path[0]][x.observations[0]];
      for(let t=1;t<4;t++)m*=T[path[t-1]][path[t]]*E[path[t]][x.observations[t]];
      likelihood+=m;if(path.at(-1)===1)finalTrue+=m;
      if(m>max+1e-15){max=m;best=path;maxCount=1;}else if(Math.abs(m-max)<=1e-15)maxCount++;
    }
    near(num(r.observationLikelihood),likelihood);
    near(num(r.posteriorTrue),finalTrue/likelihood);
    near(num(r.viterbiJointProbability),max);
    if(maxCount===1)assert.deepEqual(r.viterbiPath,best);
  }
});

test('HMM rejects impossible evidence and malformed rows', () => {
  assert.throws(()=>inferHiddenMarkov({...hmm,emission:[['1/1','0/1'],['1/1','0/1']],observations:[1]}),/zero probability/);
  assert.throws(()=>inferHiddenMarkov({...hmm,transition:[['1/2','1/4'],['1/2','1/2']]}),/sum to one/);
  assert.throws(()=>inferHiddenMarkov({...hmm,observations:[2]}),/safe integer/);
});

test('Coined quantum walk conserves norm and demonstrates interference', () => {
  const one=simulateCoinedQuantumWalk({...walk,sites:5,steps:1});
  near(one.positionProbabilities[1],.5);near(one.positionProbabilities[4],.5);
  near(one.positionProbabilities.reduce((s,p)=>s+p,0),1);
  for(const steps of [0,1,2,3,4,16,128]) {
    const r=simulateCoinedQuantumWalk({...walk,steps});
    near(r.norm,1,1e-10);
    near(r.coinProbabilities.reduce((s,p)=>s+p,0),1);
    assert.equal(r.physicalQpuExecution,false);
  }
  const returnToInitial=simulateCoinedQuantumWalk({...walk,sites:5,steps:2});
  near(returnToInitial.positionProbabilities[0],.5);
});

test('Coined walk rejects unnormalized state and invalid sites', () => {
  assert.throws(()=>simulateCoinedQuantumWalk({...walk,coinState:[1,0,1,0]}),/squared norm/);
  assert.throws(()=>simulateCoinedQuantumWalk({...walk,sites:2}),/safe integer/);
});

test('Vector Kalman matches independent two-state analytic one-step solution', () => {
  const r=filterVectorKalman({...kalman,observations:[1]});
  near(r.mean[0],2/3);near(r.mean[1],1/3);
  near(r.covariance[0][0],2/3);near(r.covariance[0][1],1/3);
  near(r.covariance[1][1],2/3);
  near(r.trace[0].innovationVariance,3);
  near(r.logLikelihood,-.5*(Math.log(6*Math.PI)+1/3));
});

test('Vector Kalman null reading propagates dynamics without fictitious evidence', () => {
  const r=filterVectorKalman({...kalman,observations:[null]});
  assert.deepEqual(r.mean,[0,0]);
  assert.deepEqual(r.covariance,[[2,1],[1,1]]);
  assert.equal(r.logLikelihood,0);assert.equal(r.trace[0].observed,false);
});

test('Vector Kalman rejects asymmetric, indefinite and nonfinite matrices', () => {
  assert.throws(()=>filterVectorKalman({...kalman,processCovariance:[[1,2],[0,1]]}),/symmetric/);
  assert.throws(()=>filterVectorKalman({...kalman,initialCovariance:[[1,2],[2,1]]}),/positive semidefinite/);
  assert.throws(()=>filterVectorKalman({...kalman,observations:[NaN]}),/finite/);
});

test('Chronos computes conservative offset intervals and cross-sample intersection',()=>{
  const r=synchronizeClockIntervals(chronos);
  assert.equal(r.status,'CONSISTENT');
  assert.deepEqual(r.compatibleOffset,{lower:8,upper:12,midpoint:10,uncertaintyRadius:2});
  assert.deepEqual(r.offsetMidpoints,[10,10]);
  assert.equal(r.exchanges[0].networkDelay,4);
});

test('Chronos rejects impossible timestamps and conflicting clock offsets',()=>{
  assert.throws(()=>synchronizeClockIntervals({exchanges:[{t1:0,t2:0,t3:10,t4:1}]}),/negative inferred/);
  assert.equal(synchronizeClockIntervals({exchanges:[{t1:0,t2:0,t3:0,t4:0},{t1:0,t2:10,t3:10,t4:0}]}).status,'INCONSISTENT');
});

test('Interval type-2 Karnik-Mendel agrees with all endpoint vertices',()=>{
  for(let trial=0;trial<24;trial++) {
    const rules=Array.from({length:4},(_,i)=>({centroid: -3+i*3+trial%3,lower:(i+1)/10,upper:(i+1)/10+(trial%5+1)/10}));
    const r=reduceIntervalType2({rules});
    let lo=Infinity,hi=-Infinity;
    for(let bits=0;bits<16;bits++) {
      const weights=rules.map((row,i)=>(bits>>i)&1?row.upper:row.lower);
      const y=rules.reduce((s,row,i)=>s+weights[i]*row.centroid,0)/weights.reduce((s,w)=>s+w,0);
      lo=Math.min(lo,y);hi=Math.max(hi,y);
    }
    near(r.left,lo);near(r.right,hi);near(r.crisp,(lo+hi)/2);
  }
});

test('Type-2 rejects inconsistent intervals and unsupported empty firing mass',()=>{
  assert.throws(()=>reduceIntervalType2({rules:[{centroid:1,lower:.8,upper:.2}]}),/exceeds/);
  assert.throws(()=>reduceIntervalType2({rules:[{centroid:1,lower:0,upper:1}]}),/strictly positive/);
});

test('All five new operators execute as connected SHA-linked GAUSS tasks',async()=>{
  const problem={schemaVersion:1,problemId:'wave3-interconnection',objective:'Evidence-backed scientific pipeline',tasks:[
    {taskId:'beta',operatorId:'BAYES_BINARY_EXACT_V1',input:{prior:'1/2',sensitivity:'3/4',falsePositiveRate:'1/4',evidence:'POSITIVE'}},
    {taskId:'hmm',operatorId:'HIDDEN_MARKOV_BINARY_EXACT_V1',input:{...hmm,initialTrue:{$ref:{taskId:'beta',path:['posteriorTrue']}}}},
    {taskId:'walk',operatorId:'QUANTUM_WALK_HADAMARD_CYCLE_V1',input:{...walk,initialSite:{$ref:{taskId:'hmm',path:['viterbiPath',0]}}}},
    {taskId:'clock',operatorId:'CHRONOS_CLOCK_OFFSET_INTERVAL_V1',input:chronos},
    {taskId:'kalman',operatorId:'KALMAN_VECTOR_LINEAR_GAUSSIAN_V1',input:{...kalman,observations:{$ref:{taskId:'clock',path:['offsetMidpoints']}}}},
    {taskId:'fuzzy',operatorId:'FUZZY_INTERVAL_TYPE2_KM_V1',input:{rules:[{centroid:{$ref:{taskId:'clock',path:['compatibleOffset','midpoint']}},lower:1,upper:1},{centroid:0,lower:1,upper:1}]}}
  ]};
  const r=await executeGaussAdvancedProblem(problem);
  assert.equal(r.status,'PASS');assert.equal(r.advancedOperatorCount,18);
  assert.equal(r.taskResults.length,6);
  assert.equal(r.taskResults[1].dependencies[0].taskId,'beta');
  assert.equal(r.taskResults[2].dependencies[0].taskId,'hmm');
  assert.equal(r.taskResults[4].dependencies[0].taskId,'clock');
  near(r.taskResults[5].output.crisp,5);
  assert.equal(r.reportSha256,(await executeGaussAdvancedProblem(problem)).reportSha256);
});
