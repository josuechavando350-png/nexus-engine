import { array, number } from './shared.mjs';

export function vector(value,label,min=1,max=64){return array(value,label,min,max).map((x,i)=>number(x,`${label}[${i}]`));}
export function matrix(value,label,rows,cols){return array(value,label,rows,rows).map((v,i)=>vector(v,`${label}[${i}]`,cols,cols));}
export function dot(a,b){return a.reduce((s,v,i)=>s+v*b[i],0);}
export function solveLinear(A,b){
 const n=b.length,M=A.map((row,i)=>[...row,b[i]]);
 for(let k=0;k<n;k++){
  let p=k;for(let i=k+1;i<n;i++)if(Math.abs(M[i][k])>Math.abs(M[p][k]))p=i;
  if(Math.abs(M[p][k])<=1e-13 || !Number.isFinite(M[p][k]))throw new RangeError('singular or ill-conditioned linear system');
  [M[k],M[p]]=[M[p],M[k]];
  for(let i=k+1;i<n;i++){const f=M[i][k]/M[k][k];for(let j=k;j<=n;j++)M[i][j]-=f*M[k][j];}
 }
 const x=Array(n).fill(0);
 for(let i=n-1;i>=0;i--){x[i]=(M[i][n]-M[i].slice(i+1,n).reduce((s,v,j)=>s+v*x[i+1+j],0))/M[i][i];if(!Number.isFinite(x[i]))throw new RangeError('unstable linear system');}
 return x;
}
export function leastSquares(rows,targets,regularization=1e-10){
 if(!rows.length||rows.length!==targets.length)throw new TypeError('least squares rows/targets mismatch');
 const n=rows[0].length,gram=Array.from({length:n},()=>Array(n).fill(0)),rhs=Array(n).fill(0);
 for(let r=0;r<rows.length;r++){
  if(rows[r].length!==n)throw new TypeError('ragged design matrix');
  for(let i=0;i<n;i++){rhs[i]+=rows[r][i]*targets[r];for(let j=0;j<n;j++)gram[i][j]+=rows[r][i]*rows[r][j];}
 }
 for(let i=0;i<n;i++)gram[i][i]+=regularization;
 return solveLinear(gram,rhs);
}
export function seeded(seed){let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return (s+0.5)/4294967296;};}
export function normal(rng){return Math.sqrt(-2*Math.log(rng()))*Math.cos(2*Math.PI*rng());}
export function cholesky(A){const n=A.length,L=Array.from({length:n},()=>Array(n).fill(0));for(let i=0;i<n;i++)for(let j=0;j<=i;j++){
 let s=A[i][j];for(let k=0;k<j;k++)s-=L[i][k]*L[j][k];
 if(i===j){if(s<=1e-12)throw new RangeError('covariance must be positive definite');L[i][j]=Math.sqrt(s);}else L[i][j]=s/L[j][j];
 }return L;
}
