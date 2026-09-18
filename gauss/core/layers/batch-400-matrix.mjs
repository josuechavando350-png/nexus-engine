import {fields,matrix,scalar,int,pack,gcd,abs,boundedBig} from './batch-400-common.mjs';
const one=x=>matrix(fields(x,['matrix']).matrix);
const two=x=>{fields(x,['left','right']);return [matrix(x.left),matrix(x.right)];};
const dims=a=>[a.length,a[0].length];
const R=a=>pack({matrix:a});
const V=a=>pack({value:a});
const rect=(a,b)=>{if(a.length!==b.length||a[0].length!==b[0].length)throw new TypeError('matrix dimensions mismatch');};
const identity=n=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>BigInt(i===j)));
const trans=a=>a[0].map((_,j)=>a.map(row=>row[j]));
const mult=(a,b)=>{if(a[0].length!==b.length)throw new TypeError('incompatible product dimensions');return Array.from({length:a.length},(_,i)=>Array.from({length:b[0].length},(_,j)=>{let z=0n;for(let k=0;k<b.length;k++)z=boundedBig(z+a[i][k]*b[k][j]);return z;}));};
const square=a=>{if(a.length!==a[0].length)throw new TypeError('square matrix required');return a.length;};
function det(a){const n=square(a),m=a.map(x=>x.slice());let sign=1n,p=1n;for(let k=0;k<n-1;k++){let row=k;while(row<n&&m[row][k]===0n)row++;if(row===n)return 0n;if(row!==k){[m[k],m[row]]=[m[row],m[k]];sign=-sign;}const pivot=m[k][k];for(let i=k+1;i<n;i++)for(let j=k+1;j<n;j++){const t=boundedBig(m[i][j]*pivot-m[i][k]*m[k][j]);if(t%p)throw new Error('Bareiss nonexact division');m[i][j]=t/p;}for(let i=k+1;i<n;i++)m[i][k]=0n;p=pivot;}return sign*m[n-1][n-1];}
const minor=(a,i,j)=>a.filter((_,k)=>k!==i).map(row=>row.filter((_,k)=>k!==j));
function frac(n,d=1n){if(d===0n)throw new Error('zero rational denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return [n/g,d/g];}
const ra=([a,b],[c,d])=>frac(a*d+b*c,b*d);
const rs=([a,b],[c,d])=>frac(a*d-b*c,b*d);
const rm=([a,b],[c,d])=>frac(a*c,b*d);
const rd=([a,b],[c,d])=>frac(a*d,b*c);
function elimination(a,wantInverse=false){let m=a.map((row,i)=>row.map(x=>frac(x)).concat(wantInverse?identity(a.length)[i].map(x=>frac(x)):[])),h=a.length,w=a[0].length,rank=0;for(let col=0;col<w&&rank<h;col++){let pivot=rank;while(pivot<h&&m[pivot][col][0]===0n)pivot++;if(pivot===h)continue;[m[rank],m[pivot]]=[m[pivot],m[rank]];const val=m[rank][col];for(let j=col;j<m[rank].length;j++)m[rank][j]=rd(m[rank][j],val);for(let row=0;row<h;row++)if(row!==rank){const f=m[row][col];for(let j=col;j<m[row].length;j++)m[row][j]=rs(m[row][j],rm(f,m[rank][j]));}rank++;}if(wantInverse&&rank!==h)throw new RangeError('singular matrix');return {rank,rows:m};}
export function matrixExactAdd(x){const[a,b]=two(x);rect(a,b);return R(a.map((r,i)=>r.map((v,j)=>v+b[i][j])));}
export function matrixExactSubtract(x){const[a,b]=two(x);rect(a,b);return R(a.map((r,i)=>r.map((v,j)=>v-b[i][j])));}
export function matrixExactMultiply(x){const[a,b]=two(x);return R(mult(a,b));}
export function matrixExactTranspose(x){return R(trans(one(x)));}
export function matrixExactTrace(x){const a=one(x);square(a);return V(a.reduce((s,r,i)=>s+r[i],0n));}
export function matrixExactDeterminant(x){return V(det(one(x)));}
export function matrixExactPermanent(x){const a=one(x),n=square(a);if(n>7)throw new RangeError('permanent dimension max 7');let sum=0n;for(let bits=1;bits<(1<<n);bits++){let count=0,product=1n;for(let j=0;j<n;j++)if(bits>>j&1)count++;for(let i=0;i<n;i++){let row=0n;for(let j=0;j<n;j++)if(bits>>j&1)row+=a[i][j];product*=row;}sum+=(n-count)%2?-product:product;}return V(sum);}
export function matrixExactRank(x){return pack({rank:elimination(one(x)).rank});}
export function matrixExactInverse(x){const a=one(x),n=square(a),r=elimination(a,true);return pack({numerators:r.rows.map(row=>row.slice(n).map(([v])=>v)),denominators:r.rows.map(row=>row.slice(n).map(([,v])=>v))});}
export function matrixExactAdjugate(x){const a=one(x),n=square(a);return R(n===1?[[1n]]:Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>(i+j)%2?-det(minor(a,j,i)):det(minor(a,j,i)))));}
export function matrixExactLeftGram(x){const a=one(x);return R(mult(trans(a),a));}
export function matrixExactRightGram(x){const a=one(x);return R(mult(a,trans(a)));}
export function matrixExactKronecker(x){const[a,b]=two(x);if(a.length*b.length>8||a[0].length*b[0].length>8)throw new RangeError('Kronecker result exceeds 8x8');return R(a.flatMap(row=>b.map(br=>row.flatMap(v=>br.map(w=>v*w)))));}
export function matrixExactHadamard(x){const[a,b]=two(x);rect(a,b);return R(a.map((row,i)=>row.map((v,j)=>v*b[i][j])));}
export function matrixExactScale(x){fields(x,['matrix','factor']);return R(matrix(x.matrix).map(row=>row.map(v=>v*scalar(x.factor))));}
export function matrixExactPower(x){fields(x,['matrix','exponent']);const a=matrix(x.matrix),n=square(a);let k=int(x.exponent,'exponent',0,7),r=identity(n),b=a;while(k){if(k&1)r=mult(r,b);k>>=1;if(k)b=mult(b,b);}return R(r);}
export function matrixExactRowSums(x){return pack({values:one(x).map(row=>row.reduce((s,v)=>s+v,0n))});}
export function matrixExactColumnSums(x){return pack({values:trans(one(x)).map(row=>row.reduce((s,v)=>s+v,0n))});}
export function matrixExactRowGcd(x){return pack({values:one(x).map(row=>row.reduce(gcd,0n))});}
export function matrixExactColumnGcd(x){return pack({values:trans(one(x)).map(row=>row.reduce(gcd,0n))});}
export function matrixExactDiagonalProduct(x){const a=one(x),n=square(a);let p=1n;for(let i=0;i<n;i++)p*=a[i][i];return V(p);}
export function matrixExactAntiDiagonalSum(x){const a=one(x),n=square(a);return V(a.reduce((s,row,i)=>s+row[n-1-i],0n));}
export function matrixExactSymmetric(x){const a=one(x),n=square(a);return pack({symmetric:a.every((r,i)=>r.every((v,j)=>v===a[j][i]))});}
export function matrixExactSkewSymmetric(x){const a=one(x),n=square(a);return pack({skewSymmetric:a.every((r,i)=>r.every((v,j)=>v===-a[j][i]))});}
export function matrixExactFrobeniusSquared(x){return V(one(x).flat().reduce((s,v)=>s+v*v,0n));}
const sample=[[2,1],[1,2]],args={matrix:sample},twoargs={left:sample,right:[[1,2],[3,4]]};
const definitions=[
 ['EXACT_MATRIX_ADD','Exact integer matrix addition',matrixExactAdd,twoargs],
 ['EXACT_MATRIX_SUB','Exact integer matrix subtraction',matrixExactSubtract,twoargs],
 ['EXACT_MATRIX_MUL','Exact matrix product',matrixExactMultiply,twoargs],
 ['EXACT_MATRIX_TRANSPOSE','Rectangular matrix transpose',matrixExactTranspose,args],
 ['EXACT_MATRIX_TRACE','Trace of square matrix',matrixExactTrace,args],
 ['EXACT_MATRIX_BAREISS_DET','Exact determinant with fraction-free Bareiss elimination',matrixExactDeterminant,args],
 ['EXACT_MATRIX_PERMANENT','Exact permanent by Ryser subset inclusion-exclusion',matrixExactPermanent,args],
 ['EXACT_MATRIX_RANK','Exact rational Gaussian matrix rank',matrixExactRank,args],
 ['EXACT_MATRIX_INVERSE','Exact reduced rational inverse with singularity rejection',matrixExactInverse,args],
 ['EXACT_MATRIX_ADJUGATE','Exact classical adjugate by signed minors',matrixExactAdjugate,args],
 ['EXACT_MATRIX_GRAM_LEFT','Exact left Gram matrix A^T A',matrixExactLeftGram,args],
 ['EXACT_MATRIX_GRAM_RIGHT','Exact right Gram matrix A A^T',matrixExactRightGram,args],
 ['EXACT_MATRIX_KRONECKER','Bounded Kronecker matrix product',matrixExactKronecker,twoargs],
 ['EXACT_MATRIX_HADAMARD','Hadamard elementwise matrix product',matrixExactHadamard,twoargs],
 ['EXACT_MATRIX_SCALE','Exact matrix integer scaling',matrixExactScale,{...args,factor:3}],
 ['EXACT_MATRIX_POWER','Exact integer matrix exponentiation by squaring',matrixExactPower,{...args,exponent:3}],
 ['EXACT_MATRIX_ROW_SUMS','Exact row aggregation of integer matrix',matrixExactRowSums,args],
 ['EXACT_MATRIX_COL_SUMS','Exact column aggregation of integer matrix',matrixExactColumnSums,args],
 ['EXACT_MATRIX_ROW_GCD','Nonnegative gcd of each integer matrix row',matrixExactRowGcd,args],
 ['EXACT_MATRIX_COL_GCD','Nonnegative gcd of each integer matrix column',matrixExactColumnGcd,args],
 ['EXACT_MATRIX_DIAGONAL_PRODUCT','Exact product of diagonal entries',matrixExactDiagonalProduct,args],
 ['EXACT_MATRIX_ANTIDIAGONAL_SUM','Exact antidiagonal sum',matrixExactAntiDiagonalSum,args],
 ['EXACT_MATRIX_SYMMETRIC','Exact symmetry predicate',matrixExactSymmetric,args],
 ['EXACT_MATRIX_SKEW','Exact skew-symmetry predicate',matrixExactSkewSymmetric,{matrix:[[0,2],[-2,0]]}],
 ['EXACT_MATRIX_FROB2','Exact squared Frobenius norm',matrixExactFrobeniusSquared,args],
];
export const EXACT_MATRIX_400=Object.freeze(definitions.map(([code,description,execute,input],i)=>Object.freeze({id:`GAUSS.MATH.${code}.${326+i}`,domain:'MATHEMATICS',description,execute,input:Object.freeze(input)})));
