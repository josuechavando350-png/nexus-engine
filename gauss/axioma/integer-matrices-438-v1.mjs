/* AXIOMA matrix oracle: determinant and permanent via independent permutations; inverse via cofactors. */
import {runBatchBank,seq,frac} from './batch-238-common.mjs';
const tags=['EXACT_MATRIX_ADD','EXACT_MATRIX_SUB','EXACT_MATRIX_MUL','EXACT_MATRIX_TRANSPOSE','EXACT_MATRIX_TRACE','EXACT_MATRIX_BAREISS_DET','EXACT_MATRIX_PERMANENT','EXACT_MATRIX_RANK','EXACT_MATRIX_INVERSE','EXACT_MATRIX_ADJUGATE','EXACT_MATRIX_GRAM_LEFT','EXACT_MATRIX_GRAM_RIGHT','EXACT_MATRIX_KRONECKER','EXACT_MATRIX_HADAMARD','EXACT_MATRIX_SCALE','EXACT_MATRIX_POWER','EXACT_MATRIX_ROW_SUMS','EXACT_MATRIX_COL_SUMS','EXACT_MATRIX_ROW_GCD','EXACT_MATRIX_COL_GCD','EXACT_MATRIX_DIAGONAL_PRODUCT','EXACT_MATRIX_ANTIDIAGONAL_SUM','EXACT_MATRIX_SYMMETRIC','EXACT_MATRIX_SKEW','EXACT_MATRIX_FROB2'];
const transpose=a=>a[0].map((_,j)=>a.map(r=>r[j]));
const mul=(a,b)=>a.map(row=>b[0].map((_,j)=>row.reduce((s,v,k)=>s+v*b[k][j],0n)));
const permutations=a=>a.length===0?[[]]:a.flatMap((v,i)=>permutations([...a.slice(0,i),...a.slice(i+1)]).map(rest=>[v,...rest]));
const permSign=p=>p.reduce((s,v,i)=>s*p.slice(i+1).reduce((q,w)=>q*(v>w?-1n:1n),1n),1n);
const determinant=a=>permutations(seq(a.length)).reduce((s,p)=>s+permSign(p)*p.reduce((v,j,i)=>v*a[i][j],1n),0n);
const permanent=a=>permutations(seq(a.length)).reduce((s,p)=>s+p.reduce((v,j,i)=>v*a[i][j],1n),0n);
const minor=(a,i,j)=>a.filter((_,k)=>i!==k).map(row=>row.filter((_,k)=>j!==k));
const gcd=(a,b)=>b?gcd(b,a%b):a<0n?-a:a;
const strings=a=>a.map(row=>row.map(String)),mat=a=>({matrix:strings(a)}),value=v=>({value:String(v)});
const cofactor=(a,i,j)=>((i+j)%2?-1n:1n)*determinant(minor(a,i,j));
const adj=a=>a.length===1?[[1n]]:seq(a.length).map(i=>seq(a.length).map(j=>cofactor(a,j,i)));
function rank(a){for(let k=Math.min(a.length,a[0].length);k>0;k--){const choose=(vs,n)=>n===0?[[]]:vs.flatMap((v,i)=>choose(vs.slice(i+1),n-1).map(rest=>[v,...rest]));for(const rows of choose(seq(a.length),k))for(const cols of choose(seq(a[0].length),k))if(determinant(rows.map(i=>cols.map(j=>a[i][j])))!==0n)return k;}return 0;}
function input(tag,i,r){const n=1+i%3,m=1+(i+1)%3,generate=(h,w)=>seq(h).map(()=>seq(w).map(()=>r(9)-4));let a=generate(n,m),b=generate(n,m);
 const sq=['EXACT_MATRIX_TRACE','EXACT_MATRIX_BAREISS_DET','EXACT_MATRIX_PERMANENT','EXACT_MATRIX_INVERSE','EXACT_MATRIX_ADJUGATE','EXACT_MATRIX_POWER','EXACT_MATRIX_DIAGONAL_PRODUCT','EXACT_MATRIX_ANTIDIAGONAL_SUM','EXACT_MATRIX_SYMMETRIC','EXACT_MATRIX_SKEW'].includes(tag);
 if(sq)a=generate(n,n);
 if(tag==='EXACT_MATRIX_INVERSE')a=seq(n).map(j=>seq(n).map(k=>k<j?0:k===j?(r(2)?2:-1):r(5)-2));
 if(tag==='EXACT_MATRIX_SKEW'&&i%2)a=seq(n).map(j=>seq(n).map(k=>j===k?0:j<k?r(5)-2:0)),a=a.map((row,j)=>row.map((v,k)=>j>k?-a[k][j]:v));
 if(tag==='EXACT_MATRIX_SYMMETRIC'&&i%2)a=a.map((row,j)=>row.map((v,k)=>j>k?a[k][j]:v));
 if(tag==='EXACT_MATRIX_KRONECKER'){a=generate(1+i%2,1+(i+1)%2);b=generate(1+(i+1)%2,1+i%2);}
 if(tag==='EXACT_MATRIX_MUL')b=generate(m,1+r(3));
 if(['EXACT_MATRIX_ADD','EXACT_MATRIX_SUB','EXACT_MATRIX_MUL','EXACT_MATRIX_KRONECKER','EXACT_MATRIX_HADAMARD'].includes(tag))return {left:a,right:b};
 if(tag==='EXACT_MATRIX_SCALE')return {matrix:a,factor:r(7)-3};
 if(tag==='EXACT_MATRIX_POWER')return {matrix:a,exponent:r(5)};
 return {matrix:a};
}
function ref(tag,x){const a=(x.matrix??x.left).map(row=>row.map(BigInt)),b=x.right?.map(row=>row.map(BigInt));
 switch(tag){
 case 'EXACT_MATRIX_ADD':return mat(a.map((row,i)=>row.map((v,j)=>v+b[i][j])));
 case 'EXACT_MATRIX_SUB':return mat(a.map((row,i)=>row.map((v,j)=>v-b[i][j])));
 case 'EXACT_MATRIX_MUL':return mat(mul(a,b));
 case 'EXACT_MATRIX_TRANSPOSE':return mat(transpose(a));
 case 'EXACT_MATRIX_TRACE':return value(a.reduce((s,row,i)=>s+row[i],0n));
 case 'EXACT_MATRIX_BAREISS_DET':return value(determinant(a));
 case 'EXACT_MATRIX_PERMANENT':return value(permanent(a));
 case 'EXACT_MATRIX_RANK':return {rank:rank(a)};
 case 'EXACT_MATRIX_INVERSE':{const d=determinant(a),c=adj(a),q=c.map(row=>row.map(v=>frac(v,d).split('/')));return {numerators:q.map(row=>row.map(v=>v[0])),denominators:q.map(row=>row.map(v=>v[1]))};}
 case 'EXACT_MATRIX_ADJUGATE':return mat(adj(a));
 case 'EXACT_MATRIX_GRAM_LEFT':return mat(mul(transpose(a),a));
 case 'EXACT_MATRIX_GRAM_RIGHT':return mat(mul(a,transpose(a)));
 case 'EXACT_MATRIX_KRONECKER':return mat(a.flatMap(row=>b.map(br=>row.flatMap(v=>br.map(w=>v*w)))));
 case 'EXACT_MATRIX_HADAMARD':return mat(a.map((row,i)=>row.map((v,j)=>v*b[i][j])));
 case 'EXACT_MATRIX_SCALE':return mat(a.map(row=>row.map(v=>v*BigInt(x.factor))));
 case 'EXACT_MATRIX_POWER':{let z=seq(a.length).map(i=>seq(a.length).map(j=>BigInt(i===j)));for(let k=0;k<x.exponent;k++)z=mul(z,a);return mat(z);}
 case 'EXACT_MATRIX_ROW_SUMS':return {values:a.map(r=>String(r.reduce((s,v)=>s+v,0n)))};
 case 'EXACT_MATRIX_COL_SUMS':return {values:transpose(a).map(r=>String(r.reduce((s,v)=>s+v,0n)))};
 case 'EXACT_MATRIX_ROW_GCD':return {values:a.map(r=>String(r.reduce(gcd,0n)))};
 case 'EXACT_MATRIX_COL_GCD':return {values:transpose(a).map(r=>String(r.reduce(gcd,0n)))};
 case 'EXACT_MATRIX_DIAGONAL_PRODUCT':return value(a.reduce((s,row,i)=>s*row[i],1n));
 case 'EXACT_MATRIX_ANTIDIAGONAL_SUM':return value(a.reduce((s,row,i)=>s+row[a.length-1-i],0n));
 case 'EXACT_MATRIX_SYMMETRIC':return {symmetric:a.every((r,i)=>r.every((v,j)=>v===a[j][i]))};
 case 'EXACT_MATRIX_SKEW':return {skewSymmetric:a.every((r,i)=>r.every((v,j)=>v===-a[j][i]))};
 case 'EXACT_MATRIX_FROB2':return value(a.flat().reduce((s,v)=>s+v*v,0n));
 default:throw Error('missing matrix reference '+tag);
 }
}
export const runIntegerMatrix438Bank=options=>runBatchBank({name:'AXIOMA integer matrices permutation oracle 326–350',prefix:'MATH',start:326,tags,input,reference:ref,...options});
