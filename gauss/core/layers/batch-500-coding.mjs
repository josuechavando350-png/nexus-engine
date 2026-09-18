import {keys,integer,bits,matrix2,out,tuple} from './batch-500-common.mjs';
const m=x=>{keys(x,['matrix']);return matrix2(x.matrix);};
const sq=x=>{const a=m(x);if(a.length!==a[0].length)throw new RangeError('square GF(2) matrix required');return a;};
function dot(a,b){return a.reduce((s,v,i)=>s^(v&b[i]),0);}
function elim(a, rhs=null){const n=a.length,c=a[0].length,A=a.map((r,i)=>rhs===null?r.slice():[...r,rhs[i]]),pivots=[];let rank=0;
 for(let j=0;j<c&&rank<n;j++){let p=rank;while(p<n&&!A[p][j])p++;if(p===n)continue;[A[p],A[rank]]=[A[rank],A[p]];
 for(let k=0;k<n;k++)if(k!==rank&&A[k][j])for(let t=j;t<A[k].length;t++)A[k][t]^=A[rank][t];pivots.push(j);rank++;}
 return {a:A,rank,pivots,consistent:rhs===null||A.slice(rank).every(r=>r[c]===0)};}
function mult(A,B){if(A[0].length!==B.length)throw new RangeError('GF(2) matrix dimensions disagree');return A.map(r=>B[0].map((_,j)=>B.reduce((v,b,k)=>v^(r[k]&b[j]),0)));}
function gen(x){keys(x,['generator']);const A=matrix2(x.generator,'generator',12,16);if(A.length>12)throw new RangeError('code dimension <= 12');return A;}
function code(A,word){if(word.length!==A.length)throw new RangeError('message length != generator rank');return A[0].map((_,j)=>A.reduce((s,r,i)=>s^(word[i]&r[j]),0));}
function allWords(A){const seen=new Map();for(let mask=0;mask<2**A.length;mask++){const message=A.map((_,i)=>(mask>>i)&1),w=code(A,message),key=w.join('');if(!seen.has(key))seen.set(key,{word:w,message});}return [...seen.values()];}
function pivotedColumns(A,p){return p.map(j=>A.map(r=>r[j]));}
function solve(A,b){if(b.length!==A.length)throw new RangeError('rhs length mismatch');const e=elim(A,b);if(!e.consistent)return {consistent:false,solution:null,unique:false};const sol=Array(A[0].length).fill(0);e.pivots.forEach((p,i)=>{sol[p]=e.a[i].at(-1);});return {consistent:true,solution:sol,unique:e.rank===A[0].length};}
export function gf2Rank(x){return out({rank:elim(m(x)).rank});}
export function gf2Rref(x){const e=elim(m(x));return out({rref:e.a,pivotColumns:e.pivots,rank:e.rank});}
export function gf2Nullspace(x){const A=m(x),e=elim(A),free=Array.from({length:A[0].length},(_,i)=>i).filter(j=>!e.pivots.includes(j));return out({basis:free.map(j=>{const v=Array(A[0].length).fill(0);v[j]=1;for(let i=0;i<e.rank;i++)v[e.pivots[i]]=e.a[i][j];return v;}),dimension:free.length});}
export function gf2Determinant(x){const A=sq(x);return out({determinant:elim(A).rank===A.length?1:0});}
export function gf2Inverse(x){const A=sq(x),n=A.length,aug=A.map((r,i)=>[...r,...Array.from({length:n},(_,j)=>Number(i===j))]);let row=0;
 for(let j=0;j<n;j++){let p=row;while(p<n&&!aug[p][j])p++;if(p===n)return out({invertible:false,inverse:null});[aug[row],aug[p]]=[aug[p],aug[row]];
 for(let k=0;k<n;k++)if(k!==row&&aug[k][j])for(let t=j;t<2*n;t++)aug[k][t]^=aug[row][t];row++;}
 return out({invertible:true,inverse:aug.map(r=>r.slice(n))});}
export function gf2Solve(x){keys(x,['matrix','rhs']);const A=matrix2(x.matrix),b=bits(x.rhs,'rhs',A.length,A.length);return out(solve(A,b));}
export function gf2Multiply(x){keys(x,['left','right']);return out({matrix:mult(matrix2(x.left,'left'),matrix2(x.right,'right'))});}
export function gf2Power(x){keys(x,['matrix','exponent']);const A=matrix2(x.matrix),n=A.length;if(A[0].length!==n)throw new RangeError('square matrix required');let e=integer(x.exponent,'exponent',0,100000),r=A.map((_,i)=>A.map((_,j)=>Number(i===j))),b=A;
 while(e>0){if(e%2)r=mult(r,b);e=Math.floor(e/2);if(e)b=mult(b,b);}return out({matrix:r});}
export function gf2Trace(x){const A=sq(x);return out({trace:A.reduce((s,r,i)=>s^r[i],0)});}
export function gf2Nullity(x){const A=m(x);return out({nullity:A[0].length-elim(A).rank});}
export function gf2KernelCardinality(x){const A=m(x);return out({cardinality:String(1n<<BigInt(A[0].length-elim(A).rank))});}
export function gf2ImageBasis(x){const A=m(x),p=elim(A).pivots;return out({columns:pivotedColumns(A,p),pivotColumns:p});}
export function gf2RowBasis(x){const e=elim(m(x));return out({rows:e.a.slice(0,e.rank)});}
export function gf2Transpose(x){const A=m(x);return out({matrix:A[0].map((_,j)=>A.map(r=>r[j]))});}
export function gf2Encode(x){keys(x,['generator','message']);const A=matrix2(x.generator,'generator',12,16),msg=bits(x.message,'message',A.length,A.length);return out({codeword:code(A,msg)});}
export function gf2Syndrome(x){keys(x,['parityCheck','word']);const A=matrix2(x.parityCheck,'parityCheck',12,16),w=bits(x.word,'word',A[0].length,A[0].length);return out({syndrome:A.map(r=>dot(r,w))});}
export function gf2CodeMinimumDistance(x){const A=gen(x),words=allWords(A).map(v=>v.word).filter(w=>w.some(Boolean));return out({distance:words.length?Math.min(...words.map(w=>w.reduce((a,b)=>a+b,0))):null,codewords:words.length+1});}
export function gf2WeightEnumerator(x){const A=gen(x),counts=Array(A[0].length+1).fill(0n);for(const {word} of allWords(A))counts[word.reduce((s,v)=>s+v,0)]++;return out({counts:counts.map(String)});}
export function gf2DualGenerator(x){const A=gen(x),e=elim(A),free=Array.from({length:A[0].length},(_,i)=>i).filter(j=>!e.pivots.includes(j));const basis=free.map(j=>{const v=Array(A[0].length).fill(0);v[j]=1;for(let k=0;k<e.rank;k++)v[e.pivots[k]]=e.a[k][j];return v;});return out({parityCheck:basis,dualDimension:basis.length});}
export function gf2NearestDecode(x){keys(x,['generator','received']);const A=matrix2(x.generator,'generator',12,16),r=bits(x.received,'received',A[0].length,A[0].length);let best=null,ties=0;
 for(const item of allWords(A)){const d=item.word.reduce((s,v,i)=>s+(v!==r[i]),0);if(best===null||d<best.distance){best={distance:d,...item};ties=1;}else if(d===best.distance){ties++;}}
 return out({distance:best.distance,codeword:best.word,message:best.message,tiedCodewords:ties});}
export function gf2ErasureRecover(x){keys(x,['generator','received']);const A=matrix2(x.generator,'generator',12,16),r=bitsOrNull(x.received,A[0].length),matches=allWords(A).filter(({word})=>word.every((v,i)=>r[i]===null||r[i]===v));return out({consistent:matches.length>0,unique:matches.length===1,candidates:matches.length,recovered:matches.length===1?matches[0].word:null});}
function bitsOrNull(x,n){if(!Array.isArray(x)||x.length!==n)throw new TypeError('received erasure length mismatch');return x.map((v,i)=>v===null?null:integer(v,`received[${i}]`,0,1));}
function hamEncode(data){const w=Array(7).fill(0);[2,4,5,6].forEach((p,i)=>w[p]=data[i]);for(const p of [1,2,4])w[p-1]=[1,2,3,4,5,6,7].filter(j=>j&p&&j!==p).reduce((s,j)=>s^w[j-1],0);return w;}
export function hamming74Encode(x){keys(x,['data']);const d=bits(x.data,'data',4,4);return out({codeword:hamEncode(d)});}
export function hamming74Decode(x){keys(x,['received']);const r=bits(x.received,'received',7,7),s=[1,2,4].reduce((s,p)=>s+p*([1,2,3,4,5,6,7].filter(j=>j&p).reduce((a,j)=>a^r[j-1],0)),0),w=r.slice();if(s)w[s-1]^=1;
 return out({syndrome:s,correctedPosition:s||null,codeword:w,data:[w[2],w[4],w[5],w[6]],assumption:'at most one bit error'});}
function poly(p,label){const v=bits(p,label,1,128);if(v.length>1&&v[0]===0)throw new TypeError(`${label}: leading polynomial coefficient must be one`);return v;}
function trim(a){let i=0;while(i<a.length-1&&!a[i])i++;return a.slice(i);}
function divmod(a,b){if(!b.some(Boolean))throw new RangeError('zero GF(2) divisor');const q=Array(Math.max(1,a.length-b.length+1)).fill(0),r=a.slice();for(let i=0;i<=a.length-b.length;i++)if(r[i]){q[i]=1;for(let j=0;j<b.length;j++)r[i+j]^=b[j];}return {quotient:trim(q),remainder:trim(r)};}
export function gf2PolynomialDivision(x){keys(x,['dividend','divisor']);const a=poly(x.dividend,'dividend'),b=poly(x.divisor,'divisor');return out(divmod(a,b));}
export function gf2PolynomialGcd(x){keys(x,['left','right']);let a=poly(x.left,'left'),b=poly(x.right,'right');while(b.some(Boolean)){[a,b]=[b,divmod(a,b).remainder];}return out({gcd:a});}
const A=[[1,0,1,1],[0,1,1,0],[1,1,0,1]],B=[[1,1,0],[0,1,1],[1,0,1],[1,1,1]],G=[[1,0,1,1],[0,1,1,0]];
const definitions=[
 ['GF2_RANK','Binary matrix rank by exact GF(2) elimination',gf2Rank,{matrix:A}],
 ['GF2_RREF','Binary reduced row echelon form and pivot columns',gf2Rref,{matrix:A}],
 ['GF2_NULLSPACE','Canonical GF(2) nullspace basis',gf2Nullspace,{matrix:A}],
 ['GF2_DETERMINANT','Exact determinant over the binary field',gf2Determinant,{matrix:[[1,1],[1,0]]}],
 ['GF2_INVERSE','Gauss-Jordan invertibility and inverse over GF(2)',gf2Inverse,{matrix:[[1,1],[1,0]]}],
 ['GF2_SOLVE','Consistent binary linear system with free-variable witness',gf2Solve,{matrix:A,rhs:[1,0,1]}],
 ['GF2_MATMUL','Exact binary matrix product',gf2Multiply,{left:A,right:B}],
 ['GF2_MATPOWER','Square GF(2) matrix power by repeated squaring',gf2Power,{matrix:[[1,1],[1,0]],exponent:12}],
 ['GF2_TRACE','GF(2) matrix diagonal trace',gf2Trace,{matrix:[[1,1],[1,0]]}],
 ['GF2_NULLITY','Binary linear transformation nullity',gf2Nullity,{matrix:A}],
 ['GF2_KERNEL_SIZE','Exact cardinality of a binary linear kernel',gf2KernelCardinality,{matrix:A}],
 ['GF2_IMAGE_BASIS','Independent original columns spanning binary image',gf2ImageBasis,{matrix:A}],
 ['GF2_ROW_BASIS','Independent binary row-space basis',gf2RowBasis,{matrix:A}],
 ['GF2_TRANSPOSE','Binary matrix transposition',gf2Transpose,{matrix:A}],
 ['GF2_CODE_ENCODE','Linear binary generator-matrix message encoding',gf2Encode,{generator:G,message:[1,1]}],
 ['GF2_SYNDROME','Binary parity-check syndrome',gf2Syndrome,{parityCheck:[[1,1,0,1],[1,0,1,1]],word:[1,0,1,1]}],
 ['GF2_CODE_MIN_DISTANCE','Exact minimum nonzero weight in a bounded linear code',gf2CodeMinimumDistance,{generator:G}],
 ['GF2_WEIGHT_ENUM','Complete binary linear-code weight enumerator',gf2WeightEnumerator,{generator:G}],
 ['GF2_DUAL_BASIS','Dual-code parity-check generator as nullspace basis',gf2DualGenerator,{generator:G}],
 ['GF2_NEAREST_DECODE','Exhaustive minimum-Hamming-distance codeword decoder',gf2NearestDecode,{generator:G,received:[1,1,0,0]}],
 ['GF2_ERASURE','Unique-codeword recovery from specified erasure positions',gf2ErasureRecover,{generator:G,received:[1,null,1,null]}],
 ['HAMMING74_ENCODE','Systematic Hamming (7,4) parity-bit construction',hamming74Encode,{data:[1,0,1,1]}],
 ['HAMMING74_DECODE','Hamming (7,4) single-error syndrome correction',hamming74Decode,{received:[0,1,1,0,0,1,1]}],
 ['GF2_POLY_DIV','Binary polynomial quotient and remainder by long division',gf2PolynomialDivision,{dividend:[1,0,1,1,0,1],divisor:[1,0,1]}],
 ['GF2_POLY_GCD','Monic greatest common divisor in GF(2)[x]',gf2PolynomialGcd,{left:[1,0,1,1],right:[1,1,0,1]}],
];
export const CODING_THEORY_500=tuple(definitions,'INFO','INFORMATION_THEORY');
