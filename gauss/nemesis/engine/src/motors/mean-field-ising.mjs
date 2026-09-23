import {object,array,vector,matrix,integer,number,assertFinite} from './finite-tools.mjs';
/** Coordinate ascent mean-field Bernoulli ±1 Ising with fixed fields and symmetric J. */
export function inferIsingMeanField(input){
 object(input,'ising',['field','couplings','iterations','tolerance'],['field','couplings']);const h=vector(input.field,'field',1,128),n=h.length,J=matrix(input.couplings,'couplings',n,n);
 for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(Math.abs(J[i][j]-J[j][i])>1e-12||(i===j&&J[i][i]!==0))throw new TypeError('symmetric zero-diagonal couplings required');
 const iterations=integer(input.iterations??1000,'iterations',1,100000),tol=number(input.tolerance??1e-10,'tolerance',1e-15,1);let m=h.map(Math.tanh),used=0,residual=Infinity;
 for(let t=0;t<iterations;t++){const old=m.slice();for(let i=0;i<n;i++)m[i]=Math.tanh(h[i]+J[i].reduce((s,v,j)=>s+v*m[j],0));residual=Math.max(...m.map((v,i)=>Math.abs(v-old[i])));used=t+1;if(residual<tol)break;}
 const entropy=m.reduce((s,v)=>{const p=(1+v)/2;return s-(p?p*Math.log(p):0)-(p<1?(1-p)*Math.log(1-p):0);},0);
 const freeEnergy=entropy+h.reduce((s,v,i)=>s+v*m[i],0)+J.reduce((s,row,i)=>s+.5*row.reduce((t,v,j)=>t+v*m[i]*m[j],0),0);
 const fixedPointResidual=Math.max(...m.map((v,i)=>Math.abs(v-Math.tanh(h[i]+J[i].reduce((s,w,j)=>s+w*m[j],0)))));
 const contractionFactor=Math.max(...J.map(row=>row.reduce((s,v)=>s+Math.abs(v),0)));
 const contractionCertificate=contractionFactor<1?{
  applicable:true,contractionFactor,infinityNormErrorBound:fixedPointResidual/(1-contractionFactor),
  meaning:'Banach bound for the unique mean-field fixed point when max absolute row sum of J is below one; floating-point evaluation, not an interval-arithmetic formal certificate'
 }:{applicable:false,contractionFactor,infinityNormErrorBound:null,reason:'Contraction condition not established; uniqueness and global mean-field optimality not certified'};
 return {domain:'ISING_FACTORIZED_MEAN_FIELD',means:m,probabilityPlus:m.map(v=>(1+v)/2),elbo:assertFinite(freeEnergy),residual,fixedPointResidual,contractionCertificate,iterations:used,converged:fixedPointResidual<tol,note:'Product-family mean-field approximation, not the exact Ising marginals or partition function.'};
}
