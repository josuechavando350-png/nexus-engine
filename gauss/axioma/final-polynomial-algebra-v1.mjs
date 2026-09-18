/* Direct monomial sums, synthetic division, binomial identities and finite differences. */
import assert from 'node:assert/strict';
import {runFinalBank,range} from './final-common-v1.mjs';
const sum=a=>a.reduce((s,v)=>s+v,0);
const poly=(r,n=1+r(5))=>range(n).map(()=>r(9)-4);
const trim=a=>{const b=a.slice();while(b.length>1&&b.at(-1)===0)b.pop();return b;};
const evalAt=(a,x)=>sum(a.map((v,k)=>v*x**k));
const convolve=(a,b)=>{const out=range(a.length+b.length-1).map(()=>0);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)out[i+j]+=a[i]*b[j];return trim(out);};
const choose=(n,k)=>{let t=1;for(let i=1;i<=k;i++)t=t*(n+1-i)/i;return t;};
const verify=(a,b,path='result')=>{if(typeof b==='number'){assert.ok(typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),`${path}: ${a} != ${b}`);return;}if(Array.isArray(b)){assert.ok(Array.isArray(a)&&a.length===b.length,`${path} shape`);b.forEach((v,i)=>verify(a[i],v,`${path}[${i}]`));return;}assert.deepStrictEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const key of Object.keys(b))verify(a[key],b[key],`${path}.${key}`);};
const defs=[
 {id:'GAUSS.MATH.HORNER_EVALUATION.035',make:(i,r)=>({coefficients:poly(r),at:r(7)-3}),reference:x=>({value:evalAt(x.coefficients,x.at)})},
 {id:'GAUSS.MATH.POLYNOMIAL_DERIVATIVE.036',make:(i,r)=>({coefficients:poly(r)}),reference:x=>({coefficients:trim(x.coefficients.length===1?[0]:x.coefficients.slice(1).map((c,i)=>c*(i+1)))})},
 {id:'GAUSS.MATH.DEFINITE_POLYNOMIAL_INTEGRAL.037',make:(i,r)=>({coefficients:poly(r),lower:r(7)-3,upper:r(7)-3}),reference:x=>({integral:sum(x.coefficients.map((v,i)=>v*(x.upper**(i+1)-x.lower**(i+1))/(i+1)))})},
 {id:'GAUSS.MATH.POLYNOMIAL_PRODUCT.038',make:(i,r)=>({left:poly(r),right:poly(r)}),reference:x=>({coefficients:convolve(x.left,x.right)})},
 {id:'GAUSS.MATH.POLYNOMIAL_LONG_DIVISION.039',make:(i,r)=>{const q=poly(r,1+r(4));q[q.length-1]=1+r(4);const divisor=[r(7)-3,1],rem=r(7)-3,dividend=convolve(q,divisor);dividend[0]+=rem;return {dividend,divisor};},reference:x=>{const b=x.divisor,q=[],a=x.dividend.slice();for(let k=a.length-1;k>=b.length-1;k--){const factor=a[k]/b.at(-1);q[k-b.length+1]=factor;for(let j=0;j<b.length;j++)a[k-b.length+1+j]-=factor*b[j];}return {quotient:trim(q),remainder:trim(a.slice(0,b.length-1))};}},
 {id:'GAUSS.MATH.BARYCENTRIC_INTERPOLATION.040',make:(i,r)=>{const n=3+r(3),A=r(7)-3,B=r(7)-3,C=r(7)-3;return {nodes:range(n).map(j=>j-2),values:range(n).map(j=>A+B*(j-2)+C*(j-2)**2),at:n+r(3)};},reference:x=>{const y=x.values,a=x.nodes[0],d=x.nodes[1]-a,A=y[0],C=(y[2]-2*y[1]+y[0])/(2*d*d),B=(y[1]-y[0]-C*((a+d)**2-a*a))/d;return {value:A+B*(x.at-a)+C*(x.at*x.at-a*a)};}},
 {id:'GAUSS.MATH.NEWTON_DIVIDED_DIFFERENCES.041',make:(i,r)=>{const n=2+r(4),A=r(11)-5,B=r(11)-5;return {nodes:range(n),values:range(n).map(j=>A+B*j)};},reference:x=>({nodes:x.nodes,newtonCoefficients:[x.values[0],x.values[1]-x.values[0],...range(x.nodes.length-2).map(()=>0)]})},
 {id:'GAUSS.MATH.QUADRATIC_REAL_ROOTS.042',make:(i,r)=>{const a=r(7)-3,b=r(7)-3;return {a:1,b:-(a+b),c:a*b};},reference:x=>{const D=x.b*x.b-4*x.a*x.c,root=-x.b/2,half=Math.sqrt(D)/2;return {discriminant:D,roots:D===0?[root]:[root-half,root+half],realRootCount:D===0?1:2};}},
 {id:'GAUSS.MATH.POLYNOMIAL_COMPOSITION.043',make:(i,r)=>({outer:poly(r,1+r(4)),inner:poly(r,1+r(4))}),reference:x=>{let out=[0],power=[1];for(const coefficient of x.outer){out=convolve(out,[1]);if(out.length<power.length)out.push(...range(power.length-out.length).map(()=>0));power.forEach((v,j)=>out[j]+=coefficient*v);power=convolve(power,x.inner);}return {coefficients:trim(out)};}},
 {id:'GAUSS.MATH.POLYNOMIAL_TRANSLATION.044',make:(i,r)=>({coefficients:poly(r),shift:r(7)-3}),reference:x=>{const out=range(x.coefficients.length).map(()=>0);x.coefficients.forEach((v,k)=>range(k+1).forEach(j=>{out[j]+=v*choose(k,j)*x.shift**(k-j);}));return {coefficients:trim(out)};}},
 {id:'GAUSS.MATH.BERNSTEIN_CONVERSION.045',make:(i,r)=>({coefficients:poly(r,1+r(6))}),reference:x=>{const n=x.coefficients.length-1;return {bernsteinCoefficients:range(n+1).map(k=>sum(range(k+1).map(j=>x.coefficients[j]*choose(k,j)/choose(n,j))))};}},
 {id:'GAUSS.MATH.FINITE_DIFFERENCES.046',make:(i,r)=>({values:poly(r,1+r(9))}),reference:x=>{const rows=range(x.values.length).map(k=>range(x.values.length-k).map(i=>sum(range(k+1).map(j=>(j%2===k%2?1:-1)*choose(k,j)*x.values[i+j]))));return {leadingDifferences:rows.map(row=>row[0]),rows};}}
].map(def=>({...def,verify}));
export const runFinalPolynomialAlgebraBank=options=>runFinalBank({name:'AXIOMA 12 independently evaluated real polynomial identities',definitions:defs,...options});
