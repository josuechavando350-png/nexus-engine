import {object,number,square,assertFinite,integer} from './finite-tools.mjs';
/** 2×2 discrete-time linearization: spectral radius and discrete Lyapunov certificate. */
export function evaluateLyapunovStability(input){
 object(input,'lyapunov',['A','iterations'],['A']);const A=square(input.A,'A',1,2),n=A.length;
 const iterations=integer(input.iterations??1000,'iterations',10,10000);
 let eig;
 if(n===1)eig=[[A[0][0],0]];
 else{const trace=A[0][0]+A[1][1],det=A[0][0]*A[1][1]-A[0][1]*A[1][0],disc=trace*trace-4*det;
 eig=disc>=0?[[ (trace+Math.sqrt(disc))/2,0 ],[(trace-Math.sqrt(disc))/2,0]]:[[trace/2,Math.sqrt(-disc)/2],[trace/2,-Math.sqrt(-disc)/2]];}
 const radius=Math.max(...eig.map(([r,i])=>Math.hypot(r,i)));assertFinite(radius);
 if(radius>=1)return {domain:'DISCRETE_LINEAR_SYSTEM',eigenvalues:eig,spectralRadius:radius,asymptoticallyStable:false,lyapunovCandidate:null,lyapunovResidualMax:null,iterations:0,note:'Spectral radius criterion applies to constant discrete linear dynamics only; no stable Lyapunov certificate exists for this matrix.'};
 // Sum_{k >= 0} (A^k)^T A^k is a candidate discrete Lyapunov P when radius < 1.
 let B=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j))),P=B.map(r=>r.map(()=>0));
 for(let t=0;t<iterations;t++){for(let i=0;i<n;i++)for(let j=0;j<n;j++)P[i][j]+=B.reduce((s,row)=>s+row[i]*row[j],0);
  B=B.map(row=>Array.from({length:n},(_,j)=>row.reduce((s,v,k)=>s+v*A[k][j],0))); if(B.flat().some(v=>!Number.isFinite(v)))break;
 }
 const residual=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>P[i][j]-+(i===j)-A.reduce((s,row,k)=>s+row[i]*A.reduce((z,r,l)=>z+r[j]*P[k][l],0),0)));
 return {domain:'DISCRETE_LINEAR_SYSTEM',eigenvalues:eig,spectralRadius:radius,asymptoticallyStable:radius<1,lyapunovCandidate:radius<1?P:null,lyapunovResidualMax:radius<1?Math.max(...residual.flat().map(Math.abs)):null,iterations,note:'Criterion is for exact 1×1 or 2×2 constant linear discrete dynamics; residual is numerical, not a nonlinear stability proof.'};
}
