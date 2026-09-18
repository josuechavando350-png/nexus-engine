/* Independent finite-field references: BigInt coefficient arithmetic, exhaustive divisors and interpolation, determinant by permutations. */
import {runFinalBank,range} from './final-common-v1.mjs';
const names=['FP_DIVMOD','FP_GCD','FP_HASSE_DERIVATIVE','FP_INTEGRATE','FP_COMPOSE','FP_POWER','FP_POWER_MOD','FP_MOD_INVERSE','FP_ROOT_MULTIPLICITIES','FP_LAGRANGE_INTERPOLATION','FP_RESULTANT','FP_DISCRIMINANT','FP_IRREDUCIBLE'];
const numbers=[683,684,687,688,691,692,693,694,696,697,698,699,700];
const mod=(x,p)=>Number(((BigInt(x)%BigInt(p))+BigInt(p))%BigInt(p));
const trim=(coeff,p)=>{const a=coeff.map(v=>mod(v,p));while(a.length>1&&a.at(-1)===0)a.pop();return a;};
const zero=a=>a.length===1&&a[0]===0;
const inverse=(a,p)=>{for(let i=1;i<p;i++)if(mod(a*i,p)===1)return i;throw Error('no inverse');};
const sum=(a,b,p,sign=1)=>trim(range(Math.max(a.length,b.length)).map(i=>(a[i]??0)+sign*(b[i]??0)),p);
const mul=(a,b,p)=>{const coeff=new Map();for(const [i,v] of a.entries())for(const [j,w] of b.entries())coeff.set(i+j,(coeff.get(i+j)??0n)+BigInt(v)*BigInt(w));return trim(range(a.length+b.length-1).map(i=>coeff.get(i)??0n),p);};
function divide(a,b,p){a=trim(a,p);b=trim(b,p);if(zero(b))throw Error('zero polynomial divisor');const q=Array(Math.max(1,a.length-b.length+1)).fill(0);while(!zero(a)&&a.length>=b.length){const shift=a.length-b.length,scale=mod(a.at(-1)*inverse(b.at(-1),p),p);q[shift]=scale;const term=Array(shift).fill(0).concat(b.map(v=>v*scale));a=sum(a,term,p,-1);}return {quotient:trim(q,p),remainder:a};}
function det(matrix,p){const n=matrix.length;let result=0;function search(row,used,product,parity){if(row===n){result=mod(result+(parity?-product:product),p);return;}for(let col=0;col<n;col++)if(!(used>>col&1)){const swaps=range(n).filter(j=>used>>j&1&&j>col).length;search(row+1,used|1<<col,mod(product*matrix[row][col],p),parity^(swaps%2));}}search(0,0,1,0);return result;}
function resultant(a,b,p){if(zero(a)||zero(b))return 0;const m=a.length-1,n=b.length-1;if(m===0&&n===0)return 1;if(m===0)return mod(BigInt(a[0])**BigInt(n),p);if(n===0)return mod(BigInt(b[0])**BigInt(m),p);const rows=[];for(let i=0;i<n;i++){const r=Array(m+n).fill(0);a.slice().reverse().forEach((v,j)=>r[i+j]=v);rows.push(r);}for(let i=0;i<m;i++){const r=Array(m+n).fill(0);b.slice().reverse().forEach((v,j)=>r[i+j]=v);rows.push(r);}return det(rows,p);}
const at=(a,t,p)=>mod(a.reduce((z,v,i)=>z+BigInt(v)*BigInt(t)**BigInt(i),0n),p);
const normalize=x=>trim(x.coefficients??x.left,x.prime);
function reference(tag,x){const p=x.prime,a=normalize(x),b=x.right?trim(x.right,p):null;
 switch(tag){
 case 'FP_DIVMOD':return divide(a,b,p);
 case 'FP_GCD':{let v=a,w=b;while(!zero(w)){[v,w]=[w,divide(v,w,p).remainder];}return {coefficients:zero(v)?v:trim(v.map(t=>t*inverse(v.at(-1),p)),p)};}
 case 'FP_HASSE_DERIVATIVE':{const choose=(n,k)=>{let z=1n;for(let j=1;j<=k;j++)z=z*BigInt(n-j+1)/BigInt(j);return z;};return {coefficients:trim(a.slice(x.order).map((v,i)=>BigInt(v)*choose(i+x.order,x.order)).length?a.slice(x.order).map((v,i)=>BigInt(v)*choose(i+x.order,x.order)):[0],p)};}
 case 'FP_INTEGRATE':return {coefficients:trim([0,...a.map((v,i)=>mod(v*inverse(i+1,p),p))],p)};
 case 'FP_COMPOSE':{let c=[0];for(let j=a.length-1;j>=0;j--)c=sum(mul(c,b,p),[a[j]],p);return {coefficients:c};}
 case 'FP_POWER':{let c=[1];for(let j=0;j<x.exponent;j++)c=mul(c,a,p);return {coefficients:c};}
 case 'FP_POWER_MOD':{let c=[1];for(let j=0;j<x.exponent;j++)c=divide(mul(c,a,p),trim(x.modulus,p),p).remainder;return {coefficients:divide(c,trim(x.modulus,p),p).remainder};}
 case 'FP_MOD_INVERSE':{const m=trim(x.modulus,p),root=mod(-m[0],p),value=at(a,root,p);return {invertible:value!==0,inverse:value? [inverse(value,p)]:null};}
 case 'FP_ROOT_MULTIPLICITIES':{const roots=[];for(let t=0;t<p;t++){let current=a,multiplicity=0;while(current.length>1&&at(current,t,p)===0){current=divide(current,[mod(-t,p),1],p).quotient;multiplicity++;}if(multiplicity)roots.push({root:t,multiplicity});}return {roots};}
 case 'FP_LAGRANGE_INTERPOLATION':{const pts=x.points.map(v=>mod(v,p)),vals=x.values.map(v=>mod(v,p));const n=pts.length;for(let mask=0;mask<p**n;mask++){let k=mask,coeff=range(n).map(()=>{const v=k%p;k=Math.floor(k/p);return v;});if(pts.every((t,i)=>at(coeff,t,p)===vals[i]))return {coefficients:trim(coeff,p)};}throw Error('missing interpolant');}
 case 'FP_RESULTANT':return {value:resultant(a,b,p)};
 case 'FP_DISCRIMINANT':{const degree=a.length-1;if(degree===0||zero(a))return {value:null};const der=trim(a.slice(1).map((v,i)=>v*(i+1)),p);const sign=degree*(degree-1)/2%2?-1:1;return {value:mod(sign*resultant(a,der,p)*inverse(a.at(-1),p),p)};}
 case 'FP_IRREDUCIBLE':{const degree=a.length-1;if(degree<1)return {irreducible:false};for(let d=1;d<=Math.floor(degree/2);d++)for(let mask=0;mask<p**d;mask++){let k=mask;const factor=range(d).map(()=>{const v=k%p;k=Math.floor(k/p);return v;}).concat(1);if(zero(divide(a,factor,p).remainder))return {irreducible:false};}return {irreducible:true};}
 default:throw Error('no independent prime polynomial reference '+tag);
 }
}
function sample(tag,i,r){const p=[2,3,5,7][i%4],coefficient=()=>r(p),polynomial=()=>range(1+r(4)).map(coefficient),a=polynomial(),b=polynomial();
 if(['FP_DIVMOD','FP_GCD','FP_COMPOSE','FP_RESULTANT'].includes(tag))return {prime:p,left:a,right:tag==='FP_DIVMOD'||tag==='FP_GCD'?b.concat(1):b};
 if(tag==='FP_POWER_MOD')return {prime:p,coefficients:a,exponent:r(8),modulus:[1+r(p-1),1]};
 if(tag==='FP_MOD_INVERSE')return {prime:p,coefficients:a,modulus:[r(p),1]};
 if(tag==='FP_ROOT_MULTIPLICITIES')return {prime:p,coefficients:[...range(r(3)).map(coefficient),1]};
 if(tag==='FP_LAGRANGE_INTERPOLATION'){const q=[3,5,7][i%3],n=1+r(Math.min(q,3));return {prime:q,points:range(n),values:range(n).map(()=>r(q))};}
 if(tag==='FP_HASSE_DERIVATIVE')return {prime:p,coefficients:a,order:r(6)};
 if(tag==='FP_INTEGRATE'){const characteristic=[5,7][i%2];return {prime:characteristic,coefficients:a};}
 if(tag==='FP_POWER')return {prime:p,coefficients:a,exponent:r(6)};
 if(tag==='FP_IRREDUCIBLE')return {prime:p,coefficients:[...range(r(4)).map(coefficient),1]};
 return {prime:p,coefficients:a};
}
const definitions=names.map((tag,i)=>({id:`GAUSS.MATH.${tag}.${numbers[i]}`,make:(caseIndex,rng)=>sample(tag,caseIndex,rng),reference:x=>reference(tag,x)}));
export const runFinalPrimePolynomialBank=options=>runFinalBank({name:'AXIOMA remaining 13 prime-polynomial operations 683–700',definitions,...options});
