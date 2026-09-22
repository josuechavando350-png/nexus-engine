import {object,array,number} from './shared.mjs';
import {matrix,vector} from './numerics.mjs';
const transpose=A=>A[0].map((_,j)=>A.map(r=>r[j]));
const mm=(A,B)=>A.map(r=>B[0].map((_,j)=>r.reduce((s,v,k)=>s+v*B[k][j],0)));
const mv=(A,x)=>A.map(r=>r.reduce((s,v,j)=>s+v*x[j],0));
function finite(A){if(A.flat().some(v=>!Number.isFinite(v)))throw new RangeError('Kalman numerical overflow');return A;}
/** Returns L with L L^T = A A^T using Givens QR of A^T, permitting rank deficiency. */
function lowerFactor(A){
  const B=transpose(A),n=A.length;
  for(let j=0;j<n;j++)for(let i=B.length-1;i>j;i--){
    const a=B[i-1][j],b=B[i][j];if(b===0)continue;
    const r=Math.hypot(a,b),c=a/r,s=b/r;
    for(let k=j;k<n;k++){const x=B[i-1][k],y=B[i][k];B[i-1][k]=c*x+s*y;B[i][k]=-s*x+c*y;}
  }
  const L=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>j<=i?B[j][i]:0));
  for(let j=0;j<n;j++)if(L[j][j]<0)for(let i=j;i<n;i++)L[i][j]*=-1;
  return finite(L);
}
function solveLower(L,b){const x=[];for(let i=0;i<L.length;i++){if(!(Math.abs(L[i][i])>1e-14))throw new RangeError('singular innovation covariance');x.push((b[i]-L[i].slice(0,i).reduce((s,v,j)=>s+v*x[j],0))/L[i][i]);}return x;}
function factor(raw,label,n){const S=matrix(raw,label,n,n);for(let i=0;i<n;i++){if(S[i][i]<0)throw new TypeError(`${label} negative diagonal`);for(let j=i+1;j<n;j++)if(S[i][j]!==0)throw new TypeError(`${label} must be lower triangular`);}return S;}
export function filterTimeVaryingFactorKalman(input){
  object(input,'factor Kalman',['initialMean','initialFactor','steps']);
  let mean=vector(input.initialMean,'initialMean',1,32),n=mean.length,S=factor(input.initialFactor,'initialFactor',n);const history=[];
  const steps=array(input.steps,'steps',1,10000);
  if(steps.length*n*n*n>20000000)throw new RangeError('Kalman work budget exceeded');
  for(const step of steps){
    object(step,'step',['transition','processFactor','observationMatrix','observationFactor','observation','offset'],['transition','processFactor','observationMatrix','observationFactor','observation']);
    const F=matrix(step.transition,'transition',n,n),Q=factor(step.processFactor,'processFactor',n),H=array(step.observationMatrix,'observationMatrix',1,32).map(r=>vector(r,'observation row',n,n)),m=H.length,R=factor(step.observationFactor,'observationFactor',m);
    const y=array(step.observation,'observation',m,m).map(v=>v===null?null:number(v,'observation'));
    const offset=step.offset===undefined?Array(n).fill(0):vector(step.offset,'offset',n,n);
    mean=mv(F,mean).map((v,i)=>v+offset[i]);finite([mean]);const FS=mm(F,S);S=lowerFactor(FS.map((r,i)=>[...r,...Q[i]]));
    const observed=y.map((v,i)=>v===null?-1:i).filter(i=>i>=0);let logLikelihood=0,innovation=[];
    if(observed.length){
      const k=observed.length,HH=observed.map(i=>H[i]),noise=lowerFactor(observed.map(i=>R[i])),HS=mm(HH,S);
      const pre=noise.map((r,i)=>[...r,...HS[i]]).concat(S.map(r=>[...Array(k).fill(0),...r]));
      const post=lowerFactor(pre),L=post.slice(0,k).map(r=>r.slice(0,k)),cross=post.slice(k).map(r=>r.slice(0,k));
      innovation=observed.map((j,i)=>y[j]-mv(HH,mean)[i]);const white=solveLower(L,innovation);
      mean=mean.map((v,i)=>v+mv(cross,white)[i]);finite([mean]);
      S=post.slice(k).map(r=>r.slice(k));
      logLikelihood=-.5*(k*Math.log(2*Math.PI)+2*L.reduce((s,r,i)=>s+Math.log(r[i]),0)+white.reduce((s,v)=>s+v*v,0));
      if(!Number.isFinite(logLikelihood))throw new RangeError('Kalman likelihood overflow');
    }
    history.push({mean:[...mean],factor:S.map(r=>[...r]),observedChannels:observed,innovation,logLikelihood});
  }
  return {domain:'TIME_VARYING_QR_SQUARE_ROOT_KALMAN',mean,factor:S,history,logLikelihood:history.reduce((s,h)=>s+h.logLikelihood,0),formulation:'factor-only Givens QR; null observation channels marginalized; positive-semidefinite state/process factors accepted'};
}
