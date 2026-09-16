import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gaussianLinearSolve, pivotedLogDeterminant, choleskyDecomposition,
  conjugateGradientSolve, householderQrDecomposition, qrLeastSquaresSolve,
  radixTwoFourierTransform,
} from '../core/layers/numerical-linear-algebra.mjs';
let seed = 0x51e2f8d7;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; }
const int = n => Math.floor(random() * n);
const near = (a, b, tol=1e-8) => assert(Math.abs(a-b) < tol * (1 + Math.max(Math.abs(a), Math.abs(b))), `${a} != ${b}`);
const multiply = (a, b) => a.map(row => b[0].map((_,j) => row.reduce((s,v,k) => s+v*b[k][j],0)));
const transpose = a => a[0].map((_,j) => a.map(row => row[j]));
function determinantByPermutations(a) {
  const n=a.length, used=Array(n).fill(false); let total=0;
  function visit(i, product, parity) {
    if(i===n) { total += parity*product; return; }
    for(let j=0;j<n;j++) if(!used[j]) {
      const inversions=used.slice(j+1).filter(Boolean).length;
      used[j]=true;visit(i+1,product*a[i][j],parity*(inversions%2?-1:1));used[j]=false;
    }
  } visit(0,1,1);return total;
}
function spd(n) {
 const lower=Array.from({length:n}, (_,i)=>Array.from({length:n},(_,j)=>j>i?0:(i===j?2+int(3):(int(5)-2)/10)));
 return multiply(lower,transpose(lower));
}
test('Gaussian elimination agrees with independent Cramer determinant oracle on 220 seeded systems', () => {
 for(let run=0;run<220;run++) {
  const n=1+int(4), a=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>(i===j?8:0)+int(5)-2));
  const original=Array.from({length:n},()=>int(7)-3),b=a.map(row=>row.reduce((s,v,j)=>s+v*original[j],0));
  const got=gaussianLinearSolve({coefficients:a,rhs:b});
  const det=determinantByPermutations(a);
  assert.notEqual(det,0);
  for(let j=0;j<n;j++){
   const replaced=a.map((row,i)=>row.map((v,k)=>k===j?b[i]:v));
   near(got.solution[j],determinantByPermutations(replaced)/det);
  }
  assert(got.residualInfinityNorm<1e-8);
 }
});
test('pivoted log determinant matches permutation oracle for 200 nonsingular signed matrices',()=>{
 for(let run=0;run<200;run++){
  const n=1+int(5),a=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>(i===j?10:0)+int(7)-3));
  const oracle=determinantByPermutations(a),got=pivotedLogDeterminant({coefficients:a});
  assert.equal(got.sign,Math.sign(oracle));near(got.logAbsoluteDeterminant,Math.log(Math.abs(oracle)));
 }
 const exchange=pivotedLogDeterminant({coefficients:[[0,1],[2,3]]});assert.equal(exchange.sign,-1);near(exchange.logAbsoluteDeterminant,Math.log(2));
});
test('Cholesky reconstructs SPD matrices and rejects indefinite/asymmetric matrices',()=>{
 for(let run=0;run<180;run++){
  const n=1+int(7),a=spd(n),actual=choleskyDecomposition({coefficients:a});
  const rebuilt=multiply(actual.lower,transpose(actual.lower));
  for(let i=0;i<n;i++)for(let j=0;j<n;j++)near(rebuilt[i][j],a[i][j]);
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)assert.equal(actual.lower[i][j],0);
 }
 assert.throws(()=>choleskyDecomposition({coefficients:[[1,0],[0,-1]]}),/positive definite/);
 assert.throws(()=>choleskyDecomposition({coefficients:[[2,1],[0,2]]}),/symmetric/);
});
test('conjugate gradient agrees with Gaussian solve for 180 SPD systems',()=>{
 for(let run=0;run<180;run++){
  const n=1+int(8),a=spd(n),b=Array.from({length:n},()=>int(11)-5);
  const actual=conjugateGradientSolve({coefficients:a,rhs:b});
  const reference=gaussianLinearSolve({coefficients:a,rhs:b});
  actual.solution.forEach((v,i)=>near(v,reference.solution[i],1e-7));
  assert(actual.residualInfinityNorm<1e-6);
 }
 assert.throws(()=>conjugateGradientSolve({coefficients:[[1,0],[0,-1]],rhs:[1,2]}),/positive definite/);
 assert.throws(()=>conjugateGradientSolve({coefficients:[[2,0],[0,1]],rhs:[2,1],maxIterations:1,tolerance:1e-12}),/did not converge/);
});
test('Householder QR reconstructs 170 rectangular matrices with Q transpose Q = identity',()=>{
 for(let run=0;run<170;run++){
  const n=1+int(5),m=n+int(5);
  const a=Array.from({length:m},(_,i)=>Array.from({length:n},(_,j)=>(i===j?7:0)+int(5)-2));
  const {q,r}=householderQrDecomposition({coefficients:a});
  const rebuilt=multiply(q,r),orthogonal=multiply(transpose(q),q);
  for(let i=0;i<m;i++)for(let j=0;j<n;j++)near(rebuilt[i][j],a[i][j]);
  for(let i=0;i<m;i++)for(let j=0;j<m;j++)near(orthogonal[i][j],i===j?1:0);
 }
 assert.throws(()=>householderQrDecomposition({coefficients:[[0,0],[0,0]]}),/rank deficient/);
});
test('QR least squares matches independent normal equations for 180 overdetermined systems',()=>{
 for(let run=0;run<180;run++){
  const n=1+int(5),m=n+1+int(5);
  const a=Array.from({length:m},(_,i)=>Array.from({length:n},(_,j)=>(i===j?6:0)+int(5)-2));
  const b=Array.from({length:m},()=>int(11)-5);
  const got=qrLeastSquaresSolve({coefficients:a,rhs:b});
  const ata=multiply(transpose(a),a), atb=transpose(a).map(row=>row.reduce((s,v,i)=>s+v*b[i],0));
  const normal=gaussianLinearSolve({coefficients:ata,rhs:atb});
  got.solution.forEach((v,i)=>near(v,normal.solution[i],1e-7));
  near(got.squaredError,a.reduce((s,row,i)=>s+(row.reduce((t,v,j)=>t+v*got.solution[j],0)-b[i])**2,0));
 }
 assert.throws(()=>qrLeastSquaresSolve({coefficients:[[1,1],[2,2]],rhs:[1,2]}),/rank deficient/);
});
test('radix-2 FFT matches independent direct DFT on 160 random complex vectors and round-trips',()=>{
 for(let run=0;run<160;run++){
  const n=2**int(7),real=Array.from({length:n},()=>int(11)-5),imaginary=Array.from({length:n},()=>int(11)-5);
  const got=radixTwoFourierTransform({real,imaginary});
  for(let k=0;k<n;k++){
   let re=0,im=0;
   for(let t=0;t<n;t++){
    const angle=-2*Math.PI*k*t/n,c=Math.cos(angle),s=Math.sin(angle);
    re+=real[t]*c-imaginary[t]*s; im+=real[t]*s+imaginary[t]*c;
   }
   near(got.real[k],re,1e-8);near(got.imaginary[k],im,1e-8);
  }
  const back=radixTwoFourierTransform({real:got.real,imaginary:got.imaginary,inverse:true});
  for(let i=0;i<n;i++){near(back.real[i],real[i],1e-8);near(back.imaginary[i],imaginary[i],1e-8);}
 }
 assert.throws(()=>radixTwoFourierTransform({real:[1,2,3],imaginary:[0,0,0]}),/power of two/);
});
test('all numerical operators fail closed on nonfinite, malformed and singular data',()=>{
 assert.throws(()=>gaussianLinearSolve({coefficients:[[1,2],[2,4]],rhs:[1,2]}),/singular/);
 assert.throws(()=>pivotedLogDeterminant({coefficients:[[1,2],[2,4]]}),/singular/);
 assert.throws(()=>householderQrDecomposition({coefficients:[[NaN]]}),/finite/);
 assert.throws(()=>qrLeastSquaresSolve({coefficients:[[1],[2]],rhs:[1,Infinity]}),/finite/);
 assert.throws(()=>radixTwoFourierTransform({real:[1,2],imaginary:[0]}),/length mismatch/);
});
