import {object,array,number,integer} from './shared.mjs';
import {seeded} from './numerics.mjs';
import {createTape} from '../learning/autodiff.mjs';
import {minimizeBox} from '../learning/box-optimizer.mjs';
function setup(input){
 const costs=array(input.costs,'costs',4,1024).map(v=>number(v,'diagonal cost',-1e6,1e6)),n=Math.log2(costs.length),layers=integer(input.layers,'layers',1,8);
 if(!Number.isInteger(n))throw new TypeError('cost vector length must be power of two');if(n*costs.length*layers>32768)throw new RangeError('QAOA statevector work budget exceeded');
 function evaluate(angles){
  const t=createTape(1000000),params=angles.map(t.constant),zero=t.constant(0),size=costs.length;
  let re=Array.from({length:size},()=>t.constant(1/Math.sqrt(size))),im=Array(size).fill(zero);
  for(let layer=0;layer<layers;layer++){
   for(let z=0;z<size;z++){const theta=t.scale(params[layer],costs[z]),co=t.cos(theta),si=t.sin(theta),r=re[z],i=im[z];re[z]=t.add(t.mul(co,r),t.mul(si,i));im[z]=t.sub(t.mul(co,i),t.mul(si,r));}
   const co=t.cos(params[layers+layer]),si=t.sin(params[layers+layer]);
   for(let bit=0;bit<n;bit++)for(let z=0;z<size;z++){const other=z^(1<<bit);if(z>other)continue;const a=re[z],b=im[z],d=re[other],e=im[other];re[z]=t.add(t.mul(co,a),t.mul(si,e));im[z]=t.sub(t.mul(co,b),t.mul(si,d));re[other]=t.add(t.mul(co,d),t.mul(si,b));im[other]=t.sub(t.mul(co,e),t.mul(si,a));}
  }
  const probs=re.map((v,i)=>t.add(t.mul(v,v),t.mul(im[i],im[i]))),expectation=t.sum(probs.map((v,i)=>t.scale(v,costs[i])));t.backward(expectation);
  const probabilities=probs.map(v=>v.value),normalization=probabilities.reduce((s,v)=>s+v,0);if(Math.abs(normalization-1)>1e-9)throw new RangeError('QAOA normalization lost');
  return {value:expectation.value,gradient:params.map(v=>v.gradient),probabilities,normalization};
 }
 return {costs,n,layers,evaluate};
}
export function evaluateDiagonalQAOA(input){
 object(input,'diagonal QAOA',['costs','layers','angles']);const s=setup(input),angles=array(input.angles,'angles',2*s.layers,2*s.layers).map(v=>number(v,'angle',-1000,1000));
 const result=s.evaluate(angles);return {domain:'DIAGONAL_QAOA_STATEVECTOR',expectation:result.value,gradient:result.gradient,probabilities:result.probabilities,normalization:result.normalization,angleOrder:'gammas followed by betas',qubits:s.n};
}
export function trainDiagonalQAOA(input){
 object(input,'QAOA training',['costs','layers','initialAngles','starts','seed','iterations','tolerance','goal'],['costs','layers','seed']);const s=setup(input),starts=integer(input.starts??4,'starts',1,32),rng=seeded(integer(input.seed,'seed',0,2**32-1)),goal=input.goal??'maximize';
 if(!['maximize','minimize'].includes(goal))throw new TypeError('invalid QAOA goal');const sign=goal==='maximize'?-1:1,initial=input.initialAngles===undefined?null:array(input.initialAngles,'initialAngles',2*s.layers,2*s.layers).map(v=>number(v,'angle',-Math.PI,Math.PI));
 const runs=[];let best=null;
 for(let start=0;start<starts;start++){
  const x=start===0&&initial?initial:Array.from({length:2*s.layers},()=> (rng()*2-1)*Math.PI);
  const fit=minimizeBox(a=>{const r=s.evaluate(a);return {value:sign*r.value,gradient:r.gradient.map(v=>sign*v)};},x,x.map(()=>-Math.PI),x.map(()=>Math.PI),{iterations:integer(input.iterations??200,'iterations',1,2000),tolerance:number(input.tolerance??1e-7,'tolerance',1e-12,.1)});
  runs.push({objective:fit.objective,status:fit.status,iterations:fit.iterations});if(!best||fit.objective<best.objective)best=fit;
 }
 const r=s.evaluate(best.parameters),optimum=goal==='maximize'?Math.max(...s.costs):Math.min(...s.costs);
 return {domain:'TRAINED_DIAGONAL_QAOA_STATEVECTOR',status:best.status,angles:best.parameters,expectation:r.value,probabilities:r.probabilities,normalization:r.normalization,exactClassicalOptimum:optimum,expectationOptimalityGap:Math.max(0,sign*(r.value-optimum)),optimization:best,restarts:runs,trainedAngles:true,quantumHardware:false,globalAngleOptimumGuaranteed:false};
}
