import {object,array,integer,number} from './shared.mjs';
import {vector,matrix,dot,solveLinear,cholesky,seeded,normal} from './numerics.mjs';
/** Stochastic EnKF with supplied linear transition/observation models and seeded perturbed observations. */
export function filterEnsembleKalman(input){
 object(input,'ensemble Kalman',['ensemble','F','H','Q','R','observations','seed'],['ensemble','F','H','Q','R','observations']);
 const ens=array(input.ensemble,'ensemble',3,256).map((x,i)=>vector(x,`ensemble[${i}]`,1,32)),n=ens[0].length;
 if(ens.some(x=>x.length!==n))throw new TypeError('ensemble dimension mismatch');
 const F=matrix(input.F,'F',n,n),H=array(input.H,'H',1,16).map((r,i)=>vector(r,`H[${i}]`,n,n)),m=H.length;
 const Q=matrix(input.Q,'Q',n,n),R=matrix(input.R,'R',m,m);
 const obs=array(input.observations,'observations',1,128).map((y,i)=>y===null?null:vector(y,`observations[${i}]`,m,m));
 for(const [name,cov] of [['Q',Q],['R',R]])for(let i=0;i<cov.length;i++)for(let j=i+1;j<cov.length;j++)if(Math.abs(cov[i][j]-cov[j][i])>1e-10)throw new TypeError(`${name} covariance must be symmetric`);
 const seed=integer(input.seed??1,'seed',0,4294967295),rng=seeded(seed),LQ=cholesky(Q),LR=cholesky(R),N=ens.length;
 const matvec=(A,v)=>A.map(r=>dot(r,v));
 const histories=[];let ensemble=ens.map(v=>[...v]);
 for(const observation of obs){
  ensemble=ensemble.map(x=>{const z=Array.from({length:n},()=>normal(rng));return matvec(F,x).map((v,i)=>v+LQ[i].reduce((s,c,j)=>s+c*z[j],0));});
  const priorMean=Array.from({length:n},(_,i)=>ensemble.reduce((s,x)=>s+x[i],0)/N);
  if(observation!==null){
   const Y=ensemble.map(x=>matvec(H,x)),ym=Array.from({length:m},(_,j)=>Y.reduce((s,y)=>s+y[j],0)/N);
   const Cxy=Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>ensemble.reduce((s,x,k)=>s+(x[i]-priorMean[i])*(Y[k][j]-ym[j]),0)/(N-1)));
   const Cyy=Array.from({length:m},(_,i)=>Array.from({length:m},(_,j)=>Y.reduce((s,y)=>s+(y[i]-ym[i])*(y[j]-ym[j]),0)/(N-1)+R[i][j]));
   const K=Array.from({length:n},(_,i)=>Array(m).fill(0));
   for(let i=0;i<n;i++){const row=solveLinear(Cyy,Cxy[i]);for(let j=0;j<m;j++)K[i][j]=row[j];}
   ensemble=ensemble.map((x,k)=>{const z=Array.from({length:m},()=>normal(rng));const noise=LR.map((row,i)=>row.reduce((s,c,j)=>s+c*z[j],0));const residual=observation.map((v,j)=>v+noise[j]-Y[k][j]);return x.map((v,i)=>v+dot(K[i],residual));});
  }
  const mean=Array.from({length:n},(_,i)=>ensemble.reduce((s,x)=>s+x[i],0)/N);
  const cov=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>ensemble.reduce((s,x)=>s+(x[i]-mean[i])*(x[j]-mean[j]),0)/(N-1)));
  histories.push({priorMean,posteriorMean:mean,posteriorCovariance:cov,updated:observation!==null});
 }
 return {domain:'LINEAR_GAUSSIAN_STOCHASTIC_ENKF',seed,members:N,dimension:n,steps:histories,finalEnsemble:ensemble,note:'Finite-sample stochastic EnKF approximation; perturbations are seeded, no claim of exact high-dimensional posterior.'};
}
