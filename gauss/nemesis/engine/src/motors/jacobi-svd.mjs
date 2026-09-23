import {object,array,number,integer} from './shared.mjs';
import {vector,dot} from './numerics.mjs';
const norm=x=>Math.hypot(...x);
/** One-sided Jacobi; works on A directly, never squares its condition number via A^T A. */
export function fullJacobiSVD(input){
  object(input,'SVD',['rows','tolerance','maxSweeps'],['rows']);
  const A=array(input.rows,'rows',1,4096).map(r=>vector(r,'row',1,64)),m=A.length,n=A[0].length;
  if(A.some(r=>r.length!==n))throw new TypeError('ragged SVD matrix');
  const tol=number(input.tolerance??1e-12,'tolerance',1e-15,1e-3),max=integer(input.maxSweeps??100,'maxSweeps',1,1000);
  if(m*n*n>20000000)throw new RangeError('SVD operation budget exceeded');
  let scale=0;for(const row of A)for(const x of row)scale=Math.max(scale,Math.abs(x));
  const B=A.map(r=>r.map(v=>scale?v/scale:0)),V=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j)));
  let sweeps=0,converged=false;
  for(;sweeps<max;sweeps++){
    let rotations=0;
    for(let p=0;p<n;p++)for(let q=p+1;q<n;q++){
      let a=0,b=0,c=0;for(const row of B){a+=row[p]*row[p];b+=row[q]*row[q];c+=row[p]*row[q];}
      if(a===0||b===0||Math.abs(c)<=tol*Math.sqrt(a*b))continue;
      const tau=(b-a)/(2*c),t=(tau>=0?1:-1)/(Math.abs(tau)+Math.hypot(1,tau)),co=1/Math.hypot(1,t),si=co*t;
      for(const row of B){const x=row[p],y=row[q];row[p]=co*x-si*y;row[q]=si*x+co*y;}
      for(const row of V){const x=row[p],y=row[q];row[p]=co*x-si*y;row[q]=si*x+co*y;}
      rotations++;
    }
    if(!rotations){converged=true;sweeps++;break;}
  }
  const all=Array.from({length:n},(_,j)=>{const col=B.map(r=>r[j]),s=norm(col);return {singularValue:s*scale,left:s?col.map(v=>v/s):Array(m).fill(0),right:V.map(r=>r[j])};}).sort((a,b)=>b.singularValue-a.singularValue);
  if(all.some(c=>!Number.isFinite(c.singularValue)))throw new RangeError('SVD numerical overflow');
  const threshold=(all[0]?.singularValue??0)*tol,components=all.filter(c=>c.singularValue>threshold).slice(0,Math.min(m,n));
  let reconstructionSquared=0;
  for(let i=0;i<m;i++)for(let j=0;j<n;j++){const residual=A[i][j]-components.reduce((s,c)=>s+c.singularValue*c.left[i]*c.right[j],0);reconstructionSquared+=residual*residual;}
  const frobeniusResidual=Math.sqrt(reconstructionSquared);if(!Number.isFinite(frobeniusResidual))throw new RangeError('SVD residual overflow');
  return {domain:'ONE_SIDED_JACOBI_SVD',status:converged?'CONVERGED':'ITERATION_LIMIT',components,singularValues:all.slice(0,Math.min(m,n)).map(c=>c.singularValue),rank:components.length,sweeps,frobeniusResidual,rankThreshold:threshold};
}
/** Streaming right singular subspace. Retains O(rank * dimension) numbers, not historical rows. */
export function createIncrementalSVD({dimension,rank,tolerance=1e-12}){
  integer(dimension,'dimension',1,64);integer(rank,'rank',1,dimension);number(tolerance,'tolerance',1e-15,1e-3);
  let components=[],count=0,errorBound=0;
  return {
    append(row){
      const next=vector(row,'stream row',dimension,dimension);
      const summary=components.map(c=>c.right.map(v=>v*c.singularValue));summary.push(next);
      const fit=fullJacobiSVD({rows:summary,tolerance});
      if(fit.status!=='CONVERGED')throw new RangeError('incremental SVD did not converge; state was not changed');
      const removed=norm(fit.components.slice(rank).map(c=>c.singularValue));
      const newError=errorBound+removed+fit.frobeniusResidual;
      if(!Number.isFinite(newError))throw new RangeError('incremental SVD error bound overflow');
      components=fit.components.slice(0,rank).map(({singularValue,right})=>({singularValue,right}));count++;errorBound=newError;
      return this.snapshot();
    },
    snapshot(){return {domain:'INCREMENTAL_RIGHT_SINGULAR_SUBSPACE',dimension,requestedRank:rank,rowsProcessed:count,components:structuredClone(components),frobeniusCompressionErrorUpperBound:errorBound,retainedNumbers:components.length*(dimension+1),historicalLeftVectorsRetained:false};}
  };
}
export function streamSVDChunks(input){
  object(input,'stream SVD',['dimension','rank','chunks','tolerance'],['dimension','rank','chunks']);
  const stream=createIncrementalSVD(input),chunks=array(input.chunks,'chunks',1,10000);let count=0;
  for(const chunk of chunks){array(chunk,'chunk',1,10000);for(const row of chunk){if(++count>100000)throw new RangeError('stream row budget exceeded');stream.append(row);}}
  return stream.snapshot();
}
