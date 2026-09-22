import {object,array,vector,matrix,cholesky,solveLinear,transpose,mul,eye,assertFinite} from './finite-tools.mjs';
/** Bounded square-root recomputation Kalman: Joseph covariance update + Cholesky factors. */
export function squareRootKalman(input){
 object(input,'kalman',['F','H','Q','R','initialMean','initialCov','observations'],['F','H','Q','R','initialMean','initialCov','observations']);
 const x=vector(input.initialMean,'initialMean',1,8),n=x.length,F=matrix(input.F,'F',n,n),Q=matrix(input.Q,'Q',n,n),P0=matrix(input.initialCov,'initialCov',n,n);
 const H=array(input.H,'H',1,8).map((r,i)=>vector(r,`H[${i}]`,n,n)),m=H.length,R=matrix(input.R,'R',m,m),observations=array(input.observations,'observations',1,256);
 for(const [A,label] of [[Q,'Q'],[R,'R'],[P0,'initialCov']]){for(let i=0;i<A.length;i++)for(let j=0;j<A.length;j++)if(Math.abs(A[i][j]-A[j][i])>1e-10)throw new TypeError(`${label} not symmetric`);cholesky(A);}
 let mean=x.slice(),P=P0.map(r=>r.slice());const I=eye(n),Ht=transpose(H),Ft=transpose(F),history=[];
 const add=(A,B)=>A.map((r,i)=>r.map((v,j)=>v+B[i][j]));
 for(const [t,raw] of observations.entries()){
  const y=raw===null?null:vector(raw,`observations[${t}]`,m,m);
  mean=F.map(row=>row.reduce((s,v,j)=>s+v*mean[j],0));P=add(mul(mul(F,P),Ft),Q);let innovation=null;
  if(y){const S=add(mul(mul(H,P),Ht),R);cholesky(S);const PHt=mul(P,Ht);const K=PHt.map(row=>row.map((_,j)=>solveLinear(S,row)[j]));
    innovation=y.map((v,i)=>v-H[i].reduce((s,h,j)=>s+h*mean[j],0));mean=mean.map((v,i)=>v+K[i].reduce((s,k,j)=>s+k*innovation[j],0));
    const KH=mul(K,H),IKH=I.map((row,i)=>row.map((v,j)=>v-KH[i][j]));P=add(mul(mul(IKH,P),transpose(IKH)),mul(mul(K,R),transpose(K)));
  }
  const L=cholesky(P);mean.forEach(v=>assertFinite(v,'mean'));history.push({mean:mean.slice(),sqrtCov:L,innovation});
 }
 return {domain:'LINEAR_GAUSSIAN_JOSEPH_CHOLESKY',history,finalMean:mean,finalSqrtCov:history.at(-1).sqrtCov,note:'Cholesky factors recomputed each step; not an optimized high-velocity QR implementation.'};
}
