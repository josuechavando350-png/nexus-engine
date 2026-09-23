import test from 'node:test';
import assert from 'node:assert/strict';
import {fullJacobiSVD,createIncrementalSVD,streamSVDChunks,filterTimeVaryingFactorKalman,runMotor} from '../src/index.mjs';
const close=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const transpose=A=>A[0].map((_,j)=>A.map(r=>r[j]));
const mm=(A,B)=>A.map(r=>B[0].map((_,j)=>r.reduce((s,v,k)=>s+v*B[k][j],0)));
const add=(A,B)=>A.map((r,i)=>r.map((v,j)=>v+B[i][j]));
const cov=L=>mm(L,transpose(L));
const eq=(A,B,t=1e-8)=>A.forEach((r,i)=>r.forEach((v,j)=>close(v,B[i][j],t)));
test('83 full SVD rectangular reconstruction, orthogonality and known singular values',()=>{
 for(const A of [[[3,0],[0,2],[0,0]],[[1,2,3],[2,4,6]],[[0,0],[0,0]],[[1,1],[1,1.00001],[0,2]]]){
  const r=fullJacobiSVD({rows:A});assert.equal(r.status,'CONVERGED');assert.ok(r.frobeniusResidual<1e-8);
  const rebuilt=A.map((row,i)=>row.map((_,j)=>r.components.reduce((s,c)=>s+c.singularValue*c.left[i]*c.right[j],0)));eq(A,rebuilt);
  for(let i=0;i<r.rank;i++)for(let j=0;j<r.rank;j++){close(r.components[i].right.reduce((s,v,k)=>s+v*r.components[j].right[k],0),+(i===j));close(r.components[i].left.reduce((s,v,k)=>s+v*r.components[j].left[k],0),+(i===j));}
 }
 const r=fullJacobiSVD({rows:[[3,0],[0,2],[0,0]]});close(r.singularValues[0],3);close(r.singularValues[1],2);
});
test('83 full-rank streaming preserves independently accumulated second moment',()=>{
 const A=Array.from({length:30},(_,i)=>[Math.sin(i),Math.cos(i),i/30]),s=createIncrementalSVD({dimension:3,rank:3});A.forEach(r=>s.append(r));const out=s.snapshot();
 const gram=mm(transpose(A),A),reconstructed=gram.map((r,i)=>r.map((_,j)=>out.components.reduce((sum,c)=>sum+c.singularValue**2*c.right[i]*c.right[j],0)));
 eq(gram,reconstructed,1e-7);assert.equal(out.rowsProcessed,30);assert.ok(out.retainedNumbers<=12);
 assert.deepEqual(streamSVDChunks({dimension:3,rank:3,chunks:[A.slice(0,7),A.slice(7)]}),out);
});
test('83 rank-truncated stream reports conservative compression bound and no historical rows',()=>{
 const A=[[3,0],[0,2],[1,0]],s=createIncrementalSVD({dimension:2,rank:1});A.forEach(r=>s.append(r));const r=s.snapshot();
 const actual=Math.sqrt(A.reduce((sum,row)=>{const proj=r.components[0].right.reduce((s,v,j)=>s+v*row[j],0);return sum+row.reduce((s,v,j)=>s+(v-proj*r.components[0].right[j])**2,0);},0));
 assert.ok(actual<=r.frobeniusCompressionErrorUpperBound+1e-8);assert.equal(r.historicalLeftVectorsRetained,false);assert.equal(r.rowsProcessed,3);
 const snap=s.snapshot();snap.components[0].right[0]=999;assert.notEqual(s.snapshot().components[0].right[0],999);
 assert.throws(()=>s.append([1]),/row/);assert.equal(s.snapshot().rowsProcessed,3);
});
test('83 rejection and explicit nonconvergence',()=>{
 assert.throws(()=>fullJacobiSVD({rows:[[1,2],[1]]}),/ragged/);
 const r=fullJacobiSVD({rows:[[1,2,3],[4,5,7],[2,1,6]],maxSweeps:1});assert.equal(r.status,'ITERATION_LIMIT');
 assert.equal(runMotor('83',{action:'full',payload:{rows:[[1,0],[0,1]]}}).rank,2);
});
const initial={initialMean:[0,0],initialFactor:[[1,0],[.3,.8]]};
const steps=[
 {transition:[[1,.2],[0,1]],processFactor:[[.1,0],[0,.2]],observationMatrix:[[1,0],[0,1]],observationFactor:[[.5,0],[.2,.4]],observation:[1,null]},
 {transition:[[1,.4],[0,.9]],processFactor:[[0,0],[0,0]],observationMatrix:[[1,1],[1,-1]],observationFactor:[[.2,0],[.1,.3]],observation:[null,.5]},
 {transition:[[1,0],[0,1]],processFactor:[[.1,0],[0,.1]],observationMatrix:[[1,0]],observationFactor:[[.3]],observation:[null]},
];
test('96 time-varying QR filter with missing channels agrees with covariance equations',()=>{
 const r=filterTimeVaryingFactorKalman({...initial,steps});let mean=[...initial.initialMean],P=cov(initial.initialFactor);
 for(let t=0;t<steps.length;t++){
  const s=steps[t];mean=mm(s.transition,mean.map(v=>[v])).map(r=>r[0]);P=add(mm(mm(s.transition,P),transpose(s.transition)),cov(s.processFactor));
  const k=s.observation.findIndex(v=>v!==null);
  if(k>=0){const h=s.observationMatrix[k],rr=cov(s.observationFactor)[k][k],ph=P.map(r=>r.reduce((v,x,j)=>v+x*h[j],0)),innovationVariance=h.reduce((v,x,j)=>v+x*ph[j],rr),res=s.observation[k]-h.reduce((v,x,j)=>v+x*mean[j],0);mean=mean.map((v,j)=>v+ph[j]*res/innovationVariance);P=P.map((row,i)=>row.map((v,j)=>v-ph[i]*ph[j]/innovationVariance));}
  r.history[t].mean.forEach((v,j)=>close(v,mean[j]));eq(cov(r.history[t].factor),P);
 }
 assert.deepEqual(r.history.map(s=>s.observedChannels),[[0],[1],[]]);
});
test('96 correlated simultaneous observations matches direct two-dimensional Gaussian conditioning',()=>{
 const r=filterTimeVaryingFactorKalman({initialMean:[0,0],initialFactor:[[1,0],[0,1]],steps:[{transition:[[1,0],[0,1]],processFactor:[[0,0],[0,0]],observationMatrix:[[1,0],[0,1]],observationFactor:[[1,0],[.5,1]],observation:[1,2]}]});
 // Innovation covariance [[2,.5],[.5,2.25]], inverse exactly [[2.25,-.5],[-.5,2]]/4.25.
 close(r.mean[0],1.25/4.25);close(r.mean[1],3.5/4.25);eq(cov(r.factor),[[1-2.25/4.25,.5/4.25],[.5/4.25,1-2/4.25]]);
});
test('96 semidefinite factors work, singular innovations and malformed factors rejected',()=>{
 const spec={initialMean:[1],initialFactor:[[0]],steps:[{transition:[[1]],processFactor:[[0]],observationMatrix:[[1]],observationFactor:[[1]],observation:[2]}]};
 const r=runMotor('96',{action:'filter',payload:spec});close(r.mean[0],1);close(r.factor[0][0],0);
 assert.throws(()=>filterTimeVaryingFactorKalman({...spec,steps:[{...spec.steps[0],observationFactor:[[0]]}]}),/singular innovation/);
 assert.throws(()=>filterTimeVaryingFactorKalman({...initial,initialFactor:[[1,.1],[0,1]],steps}),/triangular/);
});
