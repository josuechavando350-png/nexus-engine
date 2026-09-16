import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weightedLeastSquaresLine, weightedIsotonicRegression, benjaminiHochbergFdr,
  exactPairedSignPermutation, fisherExactTwoSided, kaplanMeierSurvival,
  theilSenLine, splitConformalInterval, bernoulliSequentialLikelihood,
} from '../core/layers/statistical-inference.mjs';

let seed=0x9e3779b9;
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
const int=n=>Math.floor(random()*n);
const close=(x,y,tol=1e-9)=>Math.abs(x-y)<=tol*Math.max(1,Math.abs(x),Math.abs(y));

test('weighted least-squares line matches independently derived normal-equation solution on 160 samples',()=>{
 for(let run=0;run<160;run++){
  const n=3+int(15),x=Array.from({length:n},(_,i)=>i-8),y=x.map(v=>2*v-4+int(9)-4),weights=x.map(()=>1+int(4));
  const result=weightedLeastSquaresLine({x,y,weights});
  const w=weights.reduce((a,b)=>a+b,0),sx=x.reduce((s,v,i)=>s+v*weights[i],0),sy=y.reduce((s,v,i)=>s+v*weights[i],0);
  const sxx=x.reduce((s,v,i)=>s+v*v*weights[i],0),sxy=x.reduce((s,v,i)=>s+v*y[i]*weights[i],0);
  const slope=(w*sxy-sx*sy)/(w*sxx-sx*sx),intercept=(sy-slope*sx)/w;
  assert(close(result.slope,slope));assert(close(result.intercept,intercept));
  const witness=x.reduce((s,v,i)=>s+weights[i]*(y[i]-result.intercept-result.slope*v)**2,0);
  assert(close(result.weightedSquaredError,witness));
 }
});

function bruteIsotonicInteger(y,w){
 let best=Infinity;
 function visit(i,prev,loss){
  if(i===y.length){best=Math.min(best,loss);return;}
  for(let value=prev;value<=3;value++)visit(i+1,value,loss+w[i]*(y[i]-value)**2);
 }
 visit(0,-3,0);return best;
}
test('weighted isotonic PAV is monotone and beats exhaustive integer monotone fits in 120 cases',()=>{
 assert.deepEqual(weightedIsotonicRegression({observations:[3,1,2],weights:[1,1,1]}).fitted,[2,2,2]);
 for(let run=0;run<120;run++){
  const n=2+int(4),observations=Array.from({length:n},()=>int(7)-3),weights=observations.map(()=>1+int(3));
  const result=weightedIsotonicRegression({observations,weights});
  for(let i=1;i<n;i++)assert(result.fitted[i]>=result.fitted[i-1]);
  assert(result.weightedSquaredError<=bruteIsotonicInteger(observations,weights)+1e-9);
  for(const block of result.blocks){
   const sum=observations.slice(block.start,block.end+1).reduce((s,v,j)=>s+v*weights[block.start+j],0);
   assert(close(block.mean,sum/block.weight));
  }
 }
});

test('Benjamini-Hochberg adjusted values and discoveries match independent suffix oracle on 170 cases',()=>{
 for(let run=0;run<170;run++){
  const n=1+int(20),pValues=Array.from({length:n},()=>int(101)/100),alpha=(1+int(99))/100;
  const actual=benjaminiHochbergFdr({pValues,alpha});
  const ranked=pValues.map((p,i)=>({p,i})).sort((a,b)=>a.p-b.p||a.i-b.i);
  const expected=Array(n);
  for(let j=0;j<n;j++)expected[ranked[j].i]=Math.min(1,...ranked.slice(j).map((r,k)=>r.p*n/(j+k+1)));
  const rejected=expected.map((q,i)=>q<=alpha+1e-15?i:-1).filter(i=>i>=0);
  for(let i=0;i<n;i++)assert(close(actual.adjustedPValues[i],expected[i]));
  assert.deepEqual(actual.rejectedIndices,rejected);
 }
});

test('paired sign-flip exact p-value matches independent recursive oracle in 160 datasets',()=>{
 for(let run=0;run<160;run++){
  const differences=Array.from({length:1+int(9)},()=>int(13)-6);
  const actual=exactPairedSignPermutation({differences});
  const observed=Math.abs(differences.reduce((a,b)=>a+b,0));
  let extreme=0,total=0;
  function visit(i,sum){if(i===differences.length){total++;if(Math.abs(sum)>=observed)extreme++;return;}
    visit(i+1,sum+differences[i]);visit(i+1,sum-differences[i]);}
  visit(0,0);
  assert.equal(actual.extremeAssignments,extreme);assert.equal(actual.totalAssignments,total);
  assert.equal(actual.twoSidedPValue,extreme/total);
 }
});

function combinations(n,k){if(k<0||k>n)return 0n;let result=1n;for(let i=1;i<=Math.min(k,n-k);i++)result=result*BigInt(n-Math.min(k,n-k)+i)/BigInt(i);return result;}
function oracleFisher(table){
 const [[a,b],[c,d]]=table,r1=a+b,r2=c+d,col=a+c,N=r1+r2;
 const weight=x=>combinations(r1,x)*combinations(r2,col-x),observed=weight(a),denom=combinations(N,col);
 let tail=0n;
 for(let x=Math.max(0,col-r2);x<=Math.min(r1,col);x++)if(weight(x)<=observed)tail+=weight(x);
 return Number(tail)/Number(denom);
}
test('Fisher exact two-sided matches independent integer hypergeometric oracle on 100 tables',()=>{
 for(let run=0;run<100;run++){
  const table=[[int(9),int(9)],[int(9),int(9)]];
  if(table.flat().every(x=>x===0))table[0][0]=1;
  assert(close(fisherExactTwoSided({table}).twoSidedPValue,oracleFisher(table),1e-14));
 }
 const extreme=fisherExactTwoSided({table:[[100,0],[0,100]]});
 assert(extreme.twoSidedPValue>0&&extreme.twoSidedPValue<1e-40);
});

test('Kaplan-Meier handles event/censor ties and agrees with an independent risk-set product on 150 samples',()=>{
 assert.deepEqual(kaplanMeierSurvival({observations:[{time:1,event:1},{time:1,event:0},{time:2,event:1}]}).curve.map(x=>x.survival),[0.6666666666666667,0]);
 for(let run=0;run<150;run++){
  const observations=Array.from({length:1+int(20)},()=>({time:int(10),event:int(2)}));
  const actual=kaplanMeierSurvival({observations});let expected=1;
  for(const step of actual.curve){
   const atRisk=observations.filter(o=>o.time>=step.time).length;
   const events=observations.filter(o=>o.time===step.time&&o.event).length;
   expected*=1-events/atRisk;
   assert.equal(step.atRisk,atRisk);assert.equal(step.events,events);assert(close(step.survival,expected));
  }
 }
});

test('Theil-Sen regression matches independent pairwise-median oracle for 110 datasets',()=>{
 for(let run=0;run<110;run++){
  const n=3+int(9),x=Array.from({length:n},(_,i)=>i-4),y=x.map(v=>3*v+5+int(9)-4);
  const actual=theilSenLine({x,y});const slopes=[];
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)slopes.push((y[j]-y[i])/(x[j]-x[i]));
  slopes.sort((a,b)=>a-b);
  const median=values=>(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2;
  const s=median(slopes),intercepts=y.map((v,i)=>v-s*x[i]).sort((a,b)=>a-b);
  assert(close(actual.slope,s));assert(close(actual.intercept,median(intercepts)));
  assert.equal(actual.pairCount,slopes.length);
 }
});

test('split conformal intervals use exact n+1 quantile rank and fail closed if cutoff would be infinity',()=>{
 for(let run=0;run<180;run++){
  const n=9+int(60),residuals=Array.from({length:n},()=>int(100)),prediction=int(200)-100,alpha=0.1+int(8)/10;
  const rank=Math.ceil((n+1)*(1-alpha));
  const actual=splitConformalInterval({calibrationResiduals:residuals,prediction,alpha});
  assert.equal(actual.quantileRank,rank);
  assert.equal(actual.halfWidth,[...residuals].sort((a,b)=>a-b)[rank-1]);
  assert.equal(actual.lower,prediction-actual.halfWidth);assert.equal(actual.upper,prediction+actual.halfWidth);
 }
 assert.throws(()=>splitConformalInterval({calibrationResiduals:[0,1],prediction:1,alpha:0.01}),/insufficient calibration/u);
});

test('SPRT decisions agree with independent prefix log-likelihood crossing on 150 Bernoulli traces',()=>{
 for(let run=0;run<150;run++){
  const observations=Array.from({length:1+int(70)},()=>int(2));
  const nullRate=0.2,alternativeRate=0.8,alpha=0.05,beta=0.07;
  const got=bernoulliSequentialLikelihood({observations,nullRate,alternativeRate,alpha,beta});
  const upper=Math.log((1-beta)/alpha),lower=Math.log(beta/(1-alpha));
  let sum=0,used=0,decision='INCONCLUSIVE';
  for(const o of observations){used++;sum+=o?Math.log(alternativeRate/nullRate):Math.log((1-alternativeRate)/(1-nullRate));
    if(sum>=upper){decision='ALTERNATIVE';break;}if(sum<=lower){decision='NULL';break;}}
  assert.equal(got.decision,decision);assert.equal(got.observationsUsed,used);assert(close(got.logLikelihoodRatio,sum));
 }
 assert.throws(()=>bernoulliSequentialLikelihood({observations:[1,1,2],nullRate:0.2,alternativeRate:0.8,alpha:0.05,beta:0.05}),/must be 0 or 1/u);
});

test('all nine operators reject unsupported inputs and do not silently report numerical success',()=>{
 assert.throws(()=>weightedLeastSquaresLine({x:[1,1],y:[2,3],weights:[1,1]}),/distinct x/u);
 assert.throws(()=>weightedIsotonicRegression({observations:[1,2],weights:[0,1]}),/safe integer/u);
 assert.throws(()=>benjaminiHochbergFdr({pValues:[-0.1],alpha:0.1}),/finite/u);
 assert.throws(()=>exactPairedSignPermutation({differences:Array(17).fill(1)}),/1..16/u);
 assert.throws(()=>fisherExactTwoSided({table:[[0,0],[0,0]]}),/observations/u);
 assert.throws(()=>kaplanMeierSurvival({observations:[{time:1,event:2}]}),/0 or 1/u);
 assert.throws(()=>theilSenLine({x:[1,1],y:[2,3]}),/distinct x/u);
 assert.throws(()=>splitConformalInterval({calibrationResiduals:[2,3],prediction:0,alpha:0.01}),/insufficient/u);
 assert.throws(()=>bernoulliSequentialLikelihood({observations:[1],nullRate:0.5,alternativeRate:0.5,alpha:0.05,beta:0.05}),/distinct hypotheses/u);
});
