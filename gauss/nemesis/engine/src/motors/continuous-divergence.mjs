import {object,array,number} from './shared.mjs';
const sum=a=>a.reduce((s,x)=>s+x,0);
function gaussian(g){
  object(g,'Gaussian',['mean','covariance']);const mean=array(g.mean,'mean',1,64).map(x=>number(x,'mean coordinate')),n=mean.length;
  const A=array(g.covariance,'covariance',n,n).map(r=>array(r,'covariance row',n,n).map(x=>number(x,'covariance entry')));
  const L=Array.from({length:n},()=>Array(n).fill(0));
  for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
    if(Math.abs(A[i][j]-A[j][i])>1e-12*Math.max(1,Math.abs(A[i][j]),Math.abs(A[j][i])))throw new TypeError('covariance must be symmetric');
    let v=A[i][j];for(let k=0;k<j;k++)v-=L[i][k]*L[j][k];
    if(i===j){if(v<=0||!Number.isFinite(v))throw new TypeError('covariance must be positive definite');L[i][j]=Math.sqrt(v);}else L[i][j]=v/L[j][j];
  }
  return {mean,L,logdet:2*sum(L.map((r,i)=>Math.log(r[i])))};
}
function forward(L,b){return b.reduce((x,v,i)=>{for(let j=0;j<i;j++)v-=L[i][j]*x[j];x.push(v/L[i][i]);return x;},[]);}
export function gaussianDivergence(input){
  object(input,'Gaussian divergence',['p','q','base'],['p','q']);const p=gaussian(input.p),q=gaussian(input.q),d=p.mean.length;
  if(q.mean.length!==d)throw new TypeError('Gaussian dimensions differ');
  const base=number(input.base??Math.E,'base',1.0000001,1000),scale=Math.log(base);
  let trace=0;for(let j=0;j<d;j++){const c=forward(q.L,p.L.map(row=>row[j]));trace+=sum(c.map(x=>x*x));}
  const delta=forward(q.L,q.mean.map((v,i)=>v-p.mean[i])),quadratic=sum(delta.map(x=>x*x));
  const entropy=0.5*(d*Math.log(2*Math.PI*Math.E)+p.logdet)/scale;
  const crossEntropy=0.5*(d*Math.log(2*Math.PI)+q.logdet+trace+quadratic)/scale;
  const raw=0.5*(q.logdet-p.logdet-d+trace+quadratic)/scale;
  if(![entropy,crossEntropy,raw].every(Number.isFinite))throw new RangeError('Gaussian divergence numerical overflow');
  if(raw < -1e-8*Math.max(1,Math.abs(entropy),Math.abs(crossEntropy)))throw new RangeError('Gaussian divergence numerical instability');
  return {operator:'MULTIVARIATE_GAUSSIAN_KL_V1',dimension:d,base,entropy,crossEntropy,kl:Math.max(0,raw),meaning:'Differential entropy and KL(p||q) for supplied nonsingular Gaussians; floating-point analytic evaluation, not empirical calibration'};
}
function piecewise(model){
  object(model,'piecewise density',['edges','density']);const edges=array(model.edges,'edges',2,4097).map(x=>number(x,'edge'));
  for(let i=1;i<edges.length;i++)if(!(edges[i]>edges[i-1])||!Number.isFinite(edges[i]-edges[i-1]))throw new TypeError('edges must increase with finite widths');
  const density=array(model.density,'density',edges.length-1,edges.length-1).map(x=>number(x,'density',0));
  const mass=sum(density.map((h,i)=>h*(edges[i+1]-edges[i])));
  if(!Number.isFinite(mass)||Math.abs(mass-1)>1e-10)throw new TypeError('density integral must equal one');
  return {edges,density};
}
export function piecewiseContinuousDivergence(input){
  object(input,'piecewise divergence',['p','q','base'],['p','q']);const p=piecewise(input.p),q=piecewise(input.q),base=number(input.base??Math.E,'base',1.0000001,1000),scale=Math.log(base);
  const edges=[...new Set([...p.edges,...q.edges])].sort((a,b)=>a-b);let pi=0,qi=0,H=0,C=0,K=0,J=0,infinite=false;
  for(let i=0;i<edges.length-1;i++){
    const left=edges[i],width=edges[i+1]-left;
    while(pi<p.density.length&&p.edges[pi+1]<=left)pi++;
    while(qi<q.density.length&&q.edges[qi+1]<=left)qi++;
    const a=left>=p.edges[0]&&pi<p.density.length?p.density[pi]:0,b=left>=q.edges[0]&&qi<q.density.length?q.density[qi]:0,m=(a+b)/2;
    if(a>0){H-=width*a*Math.log(a);if(b===0)infinite=true;else{C-=width*a*Math.log(b);K+=width*a*(Math.log(a)-Math.log(b));}J+=0.5*width*a*(Math.log(a)-Math.log(m));}
    if(b>0)J+=0.5*width*b*(Math.log(b)-Math.log(m));
  }
  if(![H,C,K,J].every(Number.isFinite))throw new RangeError('piecewise divergence numerical overflow');
  return {operator:'PIECEWISE_CONTINUOUS_KL_V1',base,entropy:H/scale,crossEntropy:infinite?'Infinity':C/scale,kl:infinite?'Infinity':Math.max(0,K/scale),jensenShannon:Math.max(0,J/scale),meaning:'Exact integrals of supplied normalized piecewise-constant continuous densities, up to floating-point error; density is zero outside its edges'};
}
