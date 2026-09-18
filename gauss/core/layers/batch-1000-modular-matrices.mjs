// Exact bounded prime-field matrices: elimination, subspaces, inverse and characteristic polynomial.
import {object,arr,int,freeze,entries,range} from './batch-1000-common.mjs';
const isPrime=p=>{if(p<2)return false;for(let d=2;d*d<=p;d++)if(p%d===0)return false;return true;};
const prime=p=>{int(p,'prime',2,97);if(!isPrime(p))throw new TypeError('prime modulus required');return p;};
const mod=(x,p)=>((x%p)+p)%p;
function parse(a,p){const rows=arr(a,'matrix',1,5),w=arr(rows[0],'row 0',1,5).length;return rows.map((row,i)=>arr(row,`row ${i}`,w,w).map((v,j)=>mod(int(v,`matrix[${i}][${j}]`,-10000,10000),p)));}
const matrix=x=>{object(x,['prime','matrix']);const p=prime(x.prime);return [p,parse(x.matrix,p)];};
const both=x=>{object(x,['prime','left','right']);const p=prime(x.prime),a=parse(x.left,p),b=parse(x.right,p);return [p,a,b];};
const eqShape=(a,b)=>{if(a.length!==b.length||a[0].length!==b[0].length)throw new TypeError('matrix shape mismatch');};
const square=a=>{if(a.length!==a[0].length)throw new TypeError('square matrix required');};
const inv=(x,p)=>{for(let k=1;k<p;k++)if(mod(x*k,p)===1)return k;throw new RangeError('noninvertible pivot');};
const eye=n=>range(n).map(i=>range(n).map(j=>+(i===j)));
const mul=(a,b,p)=>{if(a[0].length!==b.length)throw new TypeError('incompatible matrix dimensions');return a.map(row=>range(b[0].length).map(j=>mod(row.reduce((s,v,k)=>s+v*b[k][j],0),p)));};
function gauss(a,p){const z=a.map(r=>r.slice()),cols=z[0].length,pivots=[];for(let col=0,row=0;col<cols&&row<z.length;col++){let r=row;while(r<z.length&&z[r][col]===0)r++;if(r===z.length)continue;[z[row],z[r]]=[z[r],z[row]];const pivot=inv(z[row][col],p);for(let j=col;j<cols;j++)z[row][j]=mod(z[row][j]*pivot,p);for(let i=0;i<z.length;i++)if(i!==row){const factor=z[i][col];for(let j=col;j<cols;j++)z[i][j]=mod(z[i][j]-factor*z[row][j],p);}pivots.push(col);row++;}return {rows:z,pivots};}
function det(a,p){square(a);const z=a.map(r=>r.slice());let d=1;for(let k=0;k<z.length;k++){let r=k;while(r<z.length&&z[r][k]===0)r++;if(r===z.length)return 0;if(r!==k){[z[k],z[r]]=[z[r],z[k]];d=mod(-d,p);}const pivot=z[k][k];d=mod(d*pivot,p);const v=inv(pivot,p);for(let i=k+1;i<z.length;i++){const f=mod(z[i][k]*v,p);for(let j=k;j<z.length;j++)z[i][j]=mod(z[i][j]-f*z[k][j],p);}}return d;}
function solve(a,b,p){if(a.length!==b.length)throw new TypeError('vector size mismatch');const n=a[0].length,{rows,pivots}=gauss(a.map((r,i)=>[...r,b[i]]),p),inconsistent=rows.some(r=>r.slice(0,n).every(v=>v===0)&&r[n]!==0);if(inconsistent)return {consistent:false,solution:null,free:n-pivots.filter(k=>k<n).length};const sol=Array(n).fill(0);pivots.forEach((col,i)=>{if(col<n)sol[col]=rows[i][n];});return {consistent:true,solution:sol,free:n-pivots.filter(k=>k<n).length};}
const scalar=x=>{object(x,['prime','matrix','scalar']);const p=prime(x.prime);return [p,parse(x.matrix,p),mod(int(x.scalar,'scalar',-10000,10000),p)];};
const system=x=>{object(x,['prime','matrix','vector']);const p=prime(x.prime),a=parse(x.matrix,p),b=arr(x.vector,'vector',a.length,a.length).map(v=>mod(int(v),p));return [p,a,b];};
export function modMatrixNormalize(x){const[p,a]=matrix(x);return freeze({matrix:a});}
export function modMatrixTranspose(x){const[p,a]=matrix(x);return freeze({matrix:range(a[0].length).map(j=>a.map(row=>row[j]))});}
export function modMatrixAdd(x){const[p,a,b]=both(x);eqShape(a,b);return freeze({matrix:a.map((r,i)=>r.map((v,j)=>mod(v+b[i][j],p)))});}
export function modMatrixSubtract(x){const[p,a,b]=both(x);eqShape(a,b);return freeze({matrix:a.map((r,i)=>r.map((v,j)=>mod(v-b[i][j],p)))});}
export function modMatrixMultiply(x){const[p,a,b]=both(x);return freeze({matrix:mul(a,b,p)});}
export function modMatrixScale(x){const[p,a,v]=scalar(x);return freeze({matrix:a.map(r=>r.map(z=>mod(z*v,p)))});}
export function modMatrixHadamard(x){const[p,a,b]=both(x);eqShape(a,b);return freeze({matrix:a.map((r,i)=>r.map((v,j)=>mod(v*b[i][j],p)))});}
export function modMatrixTrace(x){const[p,a]=matrix(x);square(a);return freeze({trace:mod(a.reduce((s,r,i)=>s+r[i],0),p)});}
export function modMatrixDeterminant(x){const[p,a]=matrix(x);return freeze({determinant:det(a,p)});}
export function modMatrixRank(x){const[p,a]=matrix(x);return freeze({rank:gauss(a,p).pivots.length});}
export function modMatrixRref(x){const[p,a]=matrix(x),r=gauss(a,p);return freeze({matrix:r.rows,pivots:r.pivots});}
export function modMatrixNullity(x){const[p,a]=matrix(x);return freeze({nullity:a[0].length-gauss(a,p).pivots.length});}
export function modMatrixKernel(x){const[p,a]=matrix(x),{rows,pivots}=gauss(a,p),free=range(a[0].length).filter(i=>!pivots.includes(i));return freeze({basis:free.map(j=>{const v=Array(a[0].length).fill(0);v[j]=1;pivots.forEach((c,i)=>v[c]=mod(-rows[i][j],p));return v;})});}
export function modMatrixColumnBasis(x){const[p,a]=matrix(x),pivots=gauss(a,p).pivots;return freeze({columns:pivots.map(j=>a.map(r=>r[j]))});}
export function modMatrixRowBasis(x){const[p,a]=matrix(x),r=gauss(a,p);return freeze({rows:r.rows.slice(0,r.pivots.length)});}
export function modMatrixInverse(x){const[p,a]=matrix(x);square(a);const n=a.length,{rows,pivots}=gauss(a.map((r,i)=>[...r,...eye(n)[i]]),p);if(pivots.some((v,i)=>v!==i)||pivots.length<n)return freeze({inverse:null});return freeze({inverse:rows.map(r=>r.slice(n))});}
export function modMatrixSolve(x){const[p,a,b]=system(x);return freeze(solve(a,b,p));}
export function modMatrixConsistent(x){const[p,a,b]=system(x);return freeze({consistent:solve(a,b,p).consistent});}
export function modMatrixSolutionCount(x){const[p,a,b]=system(x),r=solve(a,b,p);return freeze({count:r.consistent?String(BigInt(p)**BigInt(r.free)):'0'});}
export function modMatrixPower(x){object(x,['prime','matrix','exponent']);const p=prime(x.prime);let a=parse(x.matrix,p);square(a);let r=eye(a.length),k=int(x.exponent,'exponent',0,1000000);while(k){if(k%2)r=mul(r,a,p);k=Math.floor(k/2);if(k)a=mul(a,a,p);}return freeze({matrix:r});}
export function modMatrixIsIdentity(x){const[p,a]=matrix(x);square(a);return freeze({identity:a.every((r,i)=>r.every((v,j)=>v===+(i===j)))});}
export function modMatrixIsSymmetric(x){const[p,a]=matrix(x);square(a);return freeze({symmetric:a.every((r,i)=>r.every((v,j)=>v===a[j][i]))});}
export function modMatrixIsIdempotent(x){const[p,a]=matrix(x);square(a);return freeze({idempotent:JSON.stringify(mul(a,a,p))===JSON.stringify(a)});}
export function modMatrixIsOrthogonal(x){const[p,a]=matrix(x);square(a);const t=range(a.length).map(j=>a.map(r=>r[j]));return freeze({orthogonal:JSON.stringify(mul(t,a,p))===JSON.stringify(eye(a.length))});}
export function modMatrixCharacteristic(x){const[p,a]=matrix(x);square(a);const n=a.length,out=Array(n+1).fill(0);function traverse(i,perm,sign){if(i===n){let poly=[1];for(let r=0;r<n;r++){const c=a[r][perm[r]],factor=r===perm[r]?[mod(-c,p),1]:[mod(-c,p)],next=Array(poly.length+factor.length-1).fill(0);for(let j=0;j<poly.length;j++)for(let k=0;k<factor.length;k++)next[j+k]=mod(next[j+k]+poly[j]*factor[k],p);poly=next;}for(let j=0;j<poly.length;j++)out[j]=mod(out[j]+sign*poly[j],p);return;}for(let j=0;j<n;j++)if(!perm.includes(j))traverse(i+1,[...perm,j],sign*((perm.filter(v=>v>j).length%2)?-1:1));}traverse(0,[],1);return freeze({coefficients:out});}
const A=[[1,2,0],[0,1,1],[1,0,1]],B=[[2,0,1],[1,1,0],[0,1,2]],P=7,base={prime:P,matrix:A},bi={prime:P,left:A,right:B},sys={prime:P,matrix:A,vector:[1,2,3]};
const specs=[
 ['NORMALIZE','Canonical prime-field entry reduction',modMatrixNormalize,base],
 ['TRANSPOSE','Exact matrix transpose over prime field',modMatrixTranspose,base],
 ['ADD','Prime-field rectangular matrix addition',modMatrixAdd,bi],
 ['SUBTRACT','Prime-field rectangular matrix subtraction',modMatrixSubtract,bi],
 ['PRODUCT','Prime-field matrix multiplication',modMatrixMultiply,bi],
 ['SCALE','Prime-field scalar multiplication',modMatrixScale,{...base,scalar:3}],
 ['HADAMARD','Prime-field entrywise Hadamard product',modMatrixHadamard,bi],
 ['TRACE','Prime-field square matrix trace',modMatrixTrace,base],
 ['DETERMINANT','Exact modular Gaussian determinant',modMatrixDeterminant,base],
 ['RANK','Row rank by modular Gaussian elimination',modMatrixRank,base],
 ['RREF','Unique reduced row-echelon form over prime field',modMatrixRref,base],
 ['NULLITY','Dimension of finite-field nullspace',modMatrixNullity,base],
 ['KERNEL','Canonical free-variable nullspace basis',modMatrixKernel,base],
 ['COLUMN_BASIS','Original pivot-column basis of column space',modMatrixColumnBasis,base],
 ['ROW_BASIS','Nonzero RREF rows forming row-space basis',modMatrixRowBasis,base],
 ['INVERSE','Gauss-Jordan modular matrix inverse or singular witness',modMatrixInverse,base],
 ['SOLVE','Consistent linear solution with free variables set to zero',modMatrixSolve,sys],
 ['CONSISTENT','Finite-field linear system consistency predicate',modMatrixConsistent,sys],
 ['SOLUTION_COUNT','Exact number of solutions to finite-field system',modMatrixSolutionCount,sys],
 ['POWER','Fast nonnegative integer matrix exponentiation over prime field',modMatrixPower,{...base,exponent:17}],
 ['IDENTITY','Prime-field identity matrix predicate',modMatrixIsIdentity,base],
 ['SYMMETRIC','Prime-field symmetric matrix predicate',modMatrixIsSymmetric,base],
 ['IDEMPOTENT','Prime-field matrix idempotence predicate',modMatrixIsIdempotent,base],
 ['ORTHOGONAL','Transpose-times-matrix equals identity over prime field',modMatrixIsOrthogonal,base],
 ['CHAR_POLY','Exact characteristic polynomial by determinant expansion',modMatrixCharacteristic,base],
];
export const MODULAR_MATRICES_1000=entries(specs,'MATH.MODULAR_MATRICES','MATHEMATICS',926);
