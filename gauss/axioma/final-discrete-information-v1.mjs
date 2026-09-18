/* Independent finite-alphabet sums, conditional counts, symmetric-channel capacity and transport. */
import assert from 'node:assert/strict';
import {runFinalBank,range} from './final-common-v1.mjs';
const sum=a=>a.reduce((s,v)=>s+v,0);
const pmf=(r,n)=>{const a=range(n).map(()=>1+r(9)),d=sum(a);return a.map(v=>v/d);};
const H=p=>-sum(p.map(v=>v?v*Math.log(v):0));
const KL=(p,q)=>p.some((v,i)=>v>0&&q[i]===0)?null:sum(p.map((v,i)=>v?v*Math.log(v/q[i]):0));
const bad=(x,key)=>[null,{...x,[key]:null},{...x,[key]:'AXIOMA_NOT_AN_ARRAY'}];
const near=(actual,expected,key)=>assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<=((key==='alpha')?1e-5:1e-10)*Math.max(1,Math.abs(expected)),`${key}: ${actual} != ${expected}`);
const verify=(actual,expected)=>{assert.deepStrictEqual(Object.keys(actual).sort(),Object.keys(expected).sort());for(const [key,v] of Object.entries(expected)){if(typeof v==='number')near(actual[key],v,key);else if(Array.isArray(v)){assert.equal(actual[key].length,v.length);v.forEach((n,i)=>near(actual[key][i],n,`${key}[${i}]`));}else assert.deepStrictEqual(actual[key],v);}};
const pair=(r)=>{const n=2+r(6);return {p:pmf(r,n),q:pmf(r,n)};};
const defs=[
 {id:'GAUSS.INFO.KL_DIVERGENCE.018',make:(i,r)=>{const x=pair(r);if(i%11===0){x.q[0]=0;const d=sum(x.q);x.q=x.q.map(v=>v/d);}return x;},reference:x=>{const v=KL(x.p,x.q);return {kind:v===null?'POSITIVE_INFINITY':'FINITE',divergence:v};},invalid:x=>bad(x,'p'),verify},
 {id:'GAUSS.INFO.JS_DIVERGENCE.019',make:(i,r)=>pair(r),reference:x=>{const m=x.p.map((v,i)=>(v+x.q[i])/2);return {divergence:(KL(x.p,m)+KL(x.q,m))/2};},invalid:x=>bad(x,'q'),verify},
 {id:'GAUSS.INFO.TOTAL_VARIATION.020',make:(i,r)=>pair(r),reference:x=>({distance:sum(x.p.map((v,j)=>Math.abs(v-x.q[j])))/2}),invalid:x=>bad(x,'p'),verify},
 {id:'GAUSS.INFO.HELLINGER_DISTANCE.021',make:(i,r)=>pair(r),reference:x=>({distance:Math.sqrt(sum(x.p.map((v,j)=>(Math.sqrt(v)-Math.sqrt(x.q[j]))**2))/2)}),invalid:x=>bad(x,'q'),verify},
 {id:'GAUSS.INFO.BHATTACHARYYA_COEFFICIENT.022',make:(i,r)=>pair(r),reference:x=>({coefficient:sum(x.p.map((v,j)=>Math.sqrt(v*x.q[j])))}),invalid:x=>bad(x,'p'),verify},
 {id:'GAUSS.INFO.CHERNOFF_INFORMATION.023',make:(i,r)=>{const p=(1+r(15))/17;return {p:[p,1-p],q:[1-p,p]};},reference:x=>({kind:'FINITE',information:-Math.log(2*Math.sqrt(x.p[0]*x.q[0])),alpha:0.5}),invalid:x=>bad(x,'q'),verify},
 {id:'GAUSS.INFO.DISCRETE_WASSERSTEIN_ONE.024',make:(i,r)=>{const n=2+r(6),positions=[];let v=r(10)-30;for(let j=0;j<n;j++){v+=1+r(8);positions.push(v);}return {positions,p:pmf(r,n),q:pmf(r,n)};},reference:x=>{let imbalance=0,distance=0;for(let i=0;i<x.positions.length-1;i++){imbalance+=x.p[i]-x.q[i];distance+=Math.abs(imbalance)*(x.positions[i+1]-x.positions[i]);}return {distance};},invalid:x=>bad(x,'positions'),verify},
 {id:'GAUSS.INFO.BAYES_POSTERIOR.025',make:(i,r)=>{const n=1+r(7);return {prior:pmf(r,n),likelihood:range(n).map(()=>r(17)/16)};},reference:x=>{const masses=x.prior.map((v,i)=>v*x.likelihood[i]),evidence=sum(masses);return {evidence,posterior:masses.map(m=>m/evidence)};},invalid:x=>bad(x,'prior'),verify},
 {id:'GAUSS.INFO.MARKOV_ENTROPY_RATE.026',make:(i,r)=>{const a=r(17)/16;return {transition:[[1-a,a],[a,1-a]],stationary:[0.5,0.5]};},reference:x=>({entropyRate:H(x.transition[0])}),invalid:x=>bad(x,'stationary'),verify},
 {id:'GAUSS.INFO.CONDITIONAL_MUTUAL_INFORMATION.027',make:(i,r)=>{const X=1+r(3),Y=1+r(3),Z=1+r(3),w=range(X).map(()=>range(Y).map(()=>range(Z).map(()=>1+r(9)))),d=sum(w.flat(2));return {joint:w.map(plane=>plane.map(row=>row.map(v=>v/d)))};},reference:x=>{const cube=x.joint,X=cube.length,Y=cube[0].length,Z=cube[0][0].length;const pz=range(Z).map(k=>sum(cube.flatMap(plane=>plane.map(row=>row[k])))),pxz=range(X).map(i=>range(Z).map(k=>sum(cube[i].map(row=>row[k])))),pyz=range(Y).map(j=>range(Z).map(k=>sum(cube.map(plane=>plane[j][k]))));return {conditionalMutualInformation:sum(cube.flatMap((plane,i)=>plane.flatMap((row,j)=>row.map((v,k)=>v*Math.log(v*pz[k]/(pxz[i][k]*pyz[j][k])))))};},invalid:x=>bad(x,'joint'),verify},
 {id:'GAUSS.INFO.CHANNEL_CAPACITY.028',make:(i,r)=>{const e=(1+r(14))/32;return {transition:[[1-e,e],[e,1-e]]};},reference:x=>({capacity:Math.log(2)-H(x.transition[0]),achievingInput:[0.5,0.5]}),invalid:x=>bad(x,'transition'),verify},
 {id:'GAUSS.INFO.CONDITIONAL_ENTROPY.029',make:(i,r)=>{const n=1+r(4),m=1+r(4),w=range(n).map(()=>range(m).map(()=>1+r(7))),d=sum(w.flat());return {joint:w.map(row=>row.map(v=>v/d))};},reference:x=>{const col=x.joint[0].map((_,j)=>sum(x.joint.map(row=>row[j])));return {conditionalEntropy:H(x.joint.flat())-H(col)};},invalid:x=>bad(x,'joint'),verify}
];
export const runFinalDiscreteInformationBank=options=>runFinalBank({name:'AXIOMA 12 independently summed discrete information measures',definitions:defs,...options});
