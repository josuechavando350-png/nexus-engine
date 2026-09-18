/* Independent exact prime-field matrix references. Only GAUSS registry is imported to obtain the subject under test. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['NORMALIZE','TRANSPOSE','ADD','SUBTRACT','PRODUCT','SCALE','HADAMARD','TRACE','DETERMINANT','RANK','RREF','NULLITY','KERNEL','COLUMN_BASIS','ROW_BASIS','INVERSE','SOLVE','CONSISTENT','SOLUTION_COUNT','POWER','IDENTITY','SYMMETRIC','IDEMPOTENT','ORTHOGONAL','CHAR_POLY'];
const id=(tag,i)=>`GAUSS.MATH.MODULAR_MATRICES.${tag}.${926+i}`;
const mod=(x,p)=>((x%p)+p)%p;
const range=n=>Array.from({length:n},(_,i)=>i);
const norm=(a,p)=>a.map(row=>row.map(v=>mod(v,p)));
const eye=n=>range(n).map(i=>range(n).map(j=>Number(i===j)));
const transpose=a=>range(a[0].length).map(j=>a.map(row=>row[j]));
const multiply=(a,b,p)=>a.map(row=>range(b[0].length).map(j=>mod(row.reduce((s,v,k)=>s+v*b[k][j],0),p)));
const inverse=(a,p)=>{for(let j=1;j<p;j++)if(a*j%p===1)return j;throw Error('zero modular pivot');};
const permutations=n=>{if(n===0)return [[]];return range(n).flatMap(i=>permutations(n-1).map(rest=>[i,...rest.map(j=>j>=i?j+1:j)]));};
function determinant(a,p){const n=a.length;if(!n)return 1;let result=0;for(const pi of permutations(n)){let sign=1;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(pi[i]>pi[j])sign=-sign;result+=sign*pi.reduce((v,j,i)=>v*a[i][j],1);}return mod(result,p);}
function subsets(n,k){if(!k)return [[]];if(k>n)return [];return range(n).flatMap((v)=>subsets(n-v-1,k-1).map(rest=>[v,...rest.map(w=>v+1+w)]));}
function rank(a,p){for(let size=Math.min(a.length,a[0].length);size>0;size--)for(const rows of subsets(a.length,size))for(const cols of subsets(a[0].length,size))if(determinant(rows.map(i=>cols.map(j=>a[i][j])),p)!==0)return size;return 0;}
function reduceRows(a,p){const b=a.map(row=>row.slice()),pivots=[];let lead=0;for(let col=0;col<b[0].length&&lead<b.length;col++){
 let next=lead;while(next<b.length&&b[next][col]===0)next++;if(next===b.length)continue;
 [b[next],b[lead]]=[b[lead],b[next]];
 const factor=inverse(b[lead][col],p);b[lead]=b[lead].map(v=>mod(v*factor,p));
 for(let i=0;i<b.length;i++)if(i!==lead){const coeff=b[i][col];b[i]=b[i].map((v,j)=>mod(v-coeff*b[lead][j],p));}
 pivots.push(col);lead++;
 }return {rows:b,pivots};}
function solve(a,b,p){const n=a[0].length,r=rank(a,p),aug=reduceRows(a.map((row,i)=>[...row,b[i]]),p),inconsistent=aug.rows.some(row=>row.slice(0,n).every(v=>v===0)&&row[n]!==0);
 if(inconsistent)return {consistent:false,solution:null,free:n-r};
 const solution=Array(n).fill(0);for(const [i,col] of aug.pivots.entries())if(col<n)solution[col]=aug.rows[i][n];return {consistent:true,solution,free:n-r};}
function charPoly(a,p){const n=a.length,result=Array(n+1).fill(0);
 for(const pi of permutations(n)){
 let sign=1;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(pi[i]>pi[j])sign=-sign;
 let terms=[1];for(let i=0;i<n;i++){const f=i===pi[i]?[mod(-a[i][pi[i]],p),1]:[mod(-a[i][pi[i]],p)],next=Array(terms.length+f.length-1).fill(0);
 for(let j=0;j<terms.length;j++)for(let k=0;k<f.length;k++)next[j+k]=mod(next[j+k]+terms[j]*f[k],p);terms=next;}
 for(let k=0;k<terms.length;k++)result[k]=mod(result[k]+sign*terms[k],p);
 }return result;}
function reference(tag,x){const p=x.prime,a=norm(x.matrix??x.left,p),b=x.right?norm(x.right,p):null,n=a.length,columns=a[0].length,rr=reduceRows(a,p),r=rank(a,p),m=(v,w)=>mod(v+w,p);
 switch(tag){
 case 'NORMALIZE':return {matrix:a};
 case 'TRANSPOSE':return {matrix:transpose(a)};
 case 'ADD':return {matrix:a.map((row,i)=>row.map((v,j)=>m(v,b[i][j]))};
 case 'SUBTRACT':return {matrix:a.map((row,i)=>row.map((v,j)=>mod(v-b[i][j],p))};
 case 'PRODUCT':return {matrix:multiply(a,b,p)};
 case 'SCALE':return {matrix:a.map(row=>row.map(v=>mod(v*x.scalar,p)))};
 case 'HADAMARD':return {matrix:a.map((row,i)=>row.map((v,j)=>mod(v*b[i][j],p))};
 case 'TRACE':return {trace:mod(a.reduce((v,row,i)=>v+row[i],0),p)};
 case 'DETERMINANT':return {determinant:determinant(a,p)};
 case 'RANK':return {rank:r};
 case 'RREF':return {matrix:rr.rows,pivots:rr.pivots};
 case 'NULLITY':return {nullity:columns-r};
 case 'KERNEL':{const free=range(columns).filter(j=>!rr.pivots.includes(j));return {basis:free.map(j=>{const v=Array(columns).fill(0);v[j]=1;for(const [i,k]of rr.pivots.entries())v[k]=mod(-rr.rows[i][j],p);return v;})};}
 case 'COLUMN_BASIS':return {columns:rr.pivots.map(j=>a.map(row=>row[j]))};
 case 'ROW_BASIS':return {rows:rr.rows.slice(0,r)};
 case 'INVERSE':{const d=determinant(a,p);if(!d)return {inverse:null};const factor=inverse(d,p);return {inverse:range(n).map(i=>range(n).map(j=>mod((i+j)%2?-factor*determinant(a.filter((_,k)=>k!==j).map(row=>row.filter((_,k)=>k!==i)),p):factor*determinant(a.filter((_,k)=>k!==j).map(row=>row.filter((_,k)=>k!==i)),p),p)))};}
 case 'SOLVE':return solve(a,x.vector.map(v=>mod(v,p)),p);
 case 'CONSISTENT':return {consistent:solve(a,x.vector.map(v=>mod(v,p)),p).consistent};
 case 'SOLUTION_COUNT':{const s=solve(a,x.vector.map(v=>mod(v,p)),p);return {count:s.consistent?String(BigInt(p)**BigInt(s.free)):'0'};}
 case 'POWER':{let result=eye(n);for(let i=0;i<x.exponent;i++)result=multiply(result,a,p);return {matrix:result};}
 case 'IDENTITY':return {identity:JSON.stringify(a)===JSON.stringify(eye(n))};
 case 'SYMMETRIC':return {symmetric:JSON.stringify(a)===JSON.stringify(transpose(a))};
 case 'IDEMPOTENT':return {idempotent:JSON.stringify(multiply(a,a,p))===JSON.stringify(a)};
 case 'ORTHOGONAL':return {orthogonal:JSON.stringify(multiply(transpose(a),a,p))===JSON.stringify(eye(n))};
 case 'CHAR_POLY':return {coefficients:charPoly(a,p)};
 default:throw Error('unknown modular matrix reference '+tag);
 }}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const prime=[2,3,5,7][r(4)],n=1+r(3),a=range(n).map(()=>range(n).map(()=>r(4*prime+1)-2*prime));if(i%11===0&&n>1)a[1]=a[0].slice();if(i%17===0)for(let j=0;j<n;j++)for(let k=0;k<n;k++)a[j][k]=Number(j===k);
 if(['ADD','SUBTRACT','PRODUCT','HADAMARD'].includes(tag))return {prime,left:a,right:range(n).map(()=>range(n).map(()=>r(2*prime+1)-prime))};
 if(tag==='SCALE')return {prime,matrix:a,scalar:r(2*prime+1)-prime};
 if(['SOLVE','CONSISTENT','SOLUTION_COUNT'].includes(tag))return {prime,matrix:a,vector:range(n).map(()=>r(2*prime+1)-prime)};
 if(tag==='POWER')return {prime,matrix:a,exponent:r(6)};
 return {prime,matrix:a};}
export function runModularMatrixBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS exact bounded prime-field matrices',seed:'0x5de41175',oracle:'independent determinant permutations, exhaustive minor ranks, separately written row reductions and adjugate inversion',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');for(const [index,tag]of TAGS.entries()){
 const layerId=id(tag,index),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x5de41175),item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let j=0;j<100;j++){const input=inputFor(tag,j,r),expected=reference(tag,input);hash.update(JSON.stringify({id:layerId,j,input,expected}));item.validCases++;report.validCases++;let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,j,input,expected,actual:actual??null,reason:String(error)});}
 if(j===0){const field='matrix'in input?'matrix':'left',wrong=structuredClone(input);wrong[field][0][0]=1.5;const invalid=[{...input,extra:true},{...input,prime:4},wrong];
 for(const[k,v]of invalid.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(v));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,j:`invalid-${k}`,input:v,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }report.coveredOperators++;report.operatorResults.push(item);
 }report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
