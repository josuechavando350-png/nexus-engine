/* Independent bounded GF(2) oracle via integer bitmasks and exhaustive codewords. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['GF2_RANK','GF2_RREF','GF2_NULLSPACE','GF2_DETERMINANT','GF2_INVERSE','GF2_SOLVE','GF2_MATMUL','GF2_MATPOWER','GF2_TRACE','GF2_NULLITY','GF2_KERNEL_SIZE','GF2_IMAGE_BASIS','GF2_ROW_BASIS','GF2_TRANSPOSE','GF2_CODE_ENCODE','GF2_SYNDROME','GF2_CODE_MIN_DISTANCE','GF2_WEIGHT_ENUM','GF2_DUAL_BASIS','GF2_NEAREST_DECODE','GF2_ERASURE','HAMMING74_ENCODE','HAMMING74_DECODE','GF2_POLY_DIV','GF2_POLY_GCD'];
const bits=(v,n)=>seq(n).map(i=>v>>i&1),mask=a=>a.reduce((s,v,i)=>s|(v<<i),0),weight=a=>a.reduce((s,v)=>s+v,0),xor=(a,b)=>a.map((v,i)=>v^b[i]);
const trans=a=>a[0].map((_,j)=>a.map(r=>r[j]));
const mul=(a,b)=>a.map(r=>trans(b).map(c=>r.reduce((s,v,i)=>s^(v&c[i]),0)));
function rref(a){const w=a[0].length,rows=a.map(mask),pivots=[];let rank=0;for(let j=0;j<w;j++){const p=rows.findIndex((v,k)=>k>=rank&&(v&(1<<j)));if(p<0)continue;[rows[rank],rows[p]]=[rows[p],rows[rank]];for(let k=0;k<rows.length;k++)if(k!==rank&&rows[k]&(1<<j))rows[k]^=rows[rank];pivots.push(j);rank++;if(rank===rows.length)break;}return {rows:rows.map(v=>bits(v,w)),rank,pivots};}
const nullspace=a=>{const t=rref(a),free=seq(a[0].length).filter(j=>!t.pivots.includes(j));return {basis:free.map(j=>{const v=Array(a[0].length).fill(0);v[j]=1;t.pivots.forEach((p,i)=>v[p]=t.rows[i][j]);return v;}),dimension:free.length};};
const code=(a,msg)=>trans(a).map(col=>col.reduce((s,v,i)=>s^(v&msg[i]),0));
const codewords=a=>{const seen=new Map();for(let m=0;m<2**a.length;m++){const msg=bits(m,a.length),word=code(a,msg),key=word.join('');if(!seen.has(key))seen.set(key,{word,message:msg});}return [...seen.values()];};
const rank=a=>rref(a).rank;
const invert=a=>{const n=a.length,b=seq(n).map(i=>a[i].concat(bits(1<<i,n))),r=rref(b);return r.rank===n?{invertible:true,inverse:r.rows.map(row=>row.slice(n))}:{invertible:false,inverse:null};};
const prod=a=>{let z=seq(a.length).map(i=>bits(1<<i,a.length));return z;};
const polynomialTrim=a=>{while(a.length>1&&a[0]===0)a=a.slice(1);return a;};
const div=(a,b)=>{if(!b.some(Boolean))throw RangeError('zero divisor');const q=Array(Math.max(1,a.length-b.length+1)).fill(0),r=a.slice();for(let i=0;i<=a.length-b.length;i++)if(r[i]){q[i]=1;for(let j=0;j<b.length;j++)r[i+j]^=b[j];}return {quotient:polynomialTrim(q),remainder:polynomialTrim(r)};};
function input(tag,i,r){const n=1+i%3,w=1+(i+1)%4,A=seq(n).map(()=>seq(w).map(()=>r(2))),sq=seq(n).map(()=>seq(n).map(()=>r(2))),generator=seq(1+i%3).map(()=>seq(3+i%2).map(()=>r(2))),word=seq(w).map(()=>r(2));
 if(['GF2_DETERMINANT','GF2_INVERSE','GF2_MATPOWER','GF2_TRACE'].includes(tag))return tag==='GF2_MATPOWER'?{matrix:sq,exponent:r(8)}:{matrix:sq};
 if(['GF2_RANK','GF2_RREF','GF2_NULLSPACE','GF2_NULLITY','GF2_KERNEL_SIZE','GF2_IMAGE_BASIS','GF2_ROW_BASIS','GF2_TRANSPOSE'].includes(tag))return {matrix:A};
 if(tag==='GF2_SOLVE')return {matrix:A,rhs:seq(n).map(()=>r(2))};
 if(tag==='GF2_MATMUL')return {left:A,right:seq(w).map(()=>seq(1+r(3)).map(()=>r(2)))};
 if(tag==='GF2_CODE_ENCODE')return {generator,message:seq(generator.length).map(()=>r(2))};
 if(tag==='GF2_SYNDROME')return {parityCheck:A,word};
 if(['GF2_CODE_MIN_DISTANCE','GF2_WEIGHT_ENUM','GF2_DUAL_BASIS'].includes(tag))return {generator};
 if(tag==='GF2_NEAREST_DECODE')return {generator,received:seq(generator[0].length).map(()=>r(2))};
 if(tag==='GF2_ERASURE')return {generator,received:seq(generator[0].length).map(()=>r(3)===0?null:r(2))};
 if(tag==='HAMMING74_ENCODE')return {data:seq(4).map(()=>r(2))};
 if(tag==='HAMMING74_DECODE')return {received:seq(7).map(()=>r(2))};
 const poly=()=>[1,...seq(1+r(5)).map(()=>r(2))];
 if(tag==='GF2_POLY_DIV')return {dividend:poly(),divisor:poly()};
 if(tag==='GF2_POLY_GCD')return {left:poly(),right:poly()};
 throw Error('unknown GF2 input '+tag);
}
function ref(tag,x){const a=x.matrix??x.generator??x.parityCheck??x.left,b=x.right,rr=a?rref(a):null;
 switch(tag){
 case 'GF2_RANK':return {rank:rr.rank};
 case 'GF2_RREF':return {rref:rr.rows,pivotColumns:rr.pivots,rank:rr.rank};
 case 'GF2_NULLSPACE':return nullspace(a);
 case 'GF2_DETERMINANT':return {determinant:Number(rr.rank===a.length)};
 case 'GF2_INVERSE':return invert(a);
 case 'GF2_SOLVE':{const rows=seq(2**a[0].length).map(j=>bits(j,a[0].length)).filter(v=>code(trans(a),v).every((z,k)=>z===x.rhs[k]));const found=rows[0];const rrefAug=rref(a.map((row,i)=>row.concat(x.rhs[i]))),p=rr.pivots,solution=Array(a[0].length).fill(0);if(found){const e=rrefAug.rows;p.forEach((j,i)=>solution[j]=e[i][a[0].length]);}return {consistent:!!found,solution:found?solution:null,unique:!!found&&rr.rank===a[0].length};}
 case 'GF2_MATMUL':return {matrix:mul(a,b)};
 case 'GF2_MATPOWER':{let z=prod(a);for(let j=0;j<x.exponent;j++)z=mul(z,a);return {matrix:z};}
 case 'GF2_TRACE':return {trace:a.reduce((s,row,i)=>s^row[i],0)};
 case 'GF2_NULLITY':return {nullity:a[0].length-rr.rank};
 case 'GF2_KERNEL_SIZE':return {cardinality:String(2**(a[0].length-rr.rank))};
 case 'GF2_IMAGE_BASIS':return {columns:rr.pivots.map(j=>a.map(row=>row[j])),pivotColumns:rr.pivots};
 case 'GF2_ROW_BASIS':return {rows:rr.rows.slice(0,rr.rank)};
 case 'GF2_TRANSPOSE':return {matrix:trans(a)};
 case 'GF2_CODE_ENCODE':return {codeword:code(a,x.message)};
 case 'GF2_SYNDROME':return {syndrome:a.map(row=>row.reduce((s,v,i)=>s^(v&x.word[i]),0))};
 case 'GF2_CODE_MIN_DISTANCE':{const ws=codewords(a),nz=ws.filter(z=>z.word.some(Boolean));return {distance:nz.length?Math.min(...nz.map(z=>weight(z.word))):null,codewords:ws.length};}
 case 'GF2_WEIGHT_ENUM':return {counts:seq(a[0].length+1).map(k=>String(codewords(a).filter(v=>weight(v.word)===k).length))};
 case 'GF2_DUAL_BASIS':{const ns=nullspace(a);return {parityCheck:ns.basis,dualDimension:ns.dimension};}
 case 'GF2_NEAREST_DECODE':{let best=null,ties=0;for(const item of codewords(a)){const d=item.word.filter((v,i)=>v!==x.received[i]).length;if(best===null||d<best.distance){best={distance:d,...item};ties=1;}else if(d===best.distance)ties++;}return {distance:best.distance,codeword:best.word,message:best.message,tiedCodewords:ties};}
 case 'GF2_ERASURE':{const matches=codewords(a).filter(v=>v.word.every((z,i)=>x.received[i]===null||z===x.received[i]));return {consistent:!!matches.length,unique:matches.length===1,candidates:matches.length,recovered:matches.length===1?matches[0].word:null};}
 case 'HAMMING74_ENCODE':{const z=Array(7).fill(0);[2,4,5,6].forEach((p,i)=>z[p]=x.data[i]);for(const p of [1,2,4])z[p-1]=seq(7).filter(j=>(j+1)&p&&j!==p-1).reduce((s,j)=>s^z[j],0);return {codeword:z};}
 case 'HAMMING74_DECODE':{const w=x.received.slice(),s=[1,2,4].reduce((t,p)=>t+p*seq(7).filter(j=>(j+1)&p).reduce((v,j)=>v^w[j],0),0);if(s)w[s-1]^=1;return {syndrome:s,correctedPosition:s||null,codeword:w,data:[w[2],w[4],w[5],w[6]],assumption:'at most one bit error'};}
 case 'GF2_POLY_DIV':return div(x.dividend,x.divisor);
 case 'GF2_POLY_GCD':{let left=x.left,right=x.right;while(right.some(Boolean)){[left,right]=[right,div(left,right).remainder];}return {gcd:left};}
 default:throw Error('missing GF2 oracle '+tag);
 }
}
export const runGf2Coding438Bank=options=>runBatchBank({name:'AXIOMA GF(2) and coding bitmask references 401–425',prefix:'INFO',start:401,tags,input,reference:ref,...options});
