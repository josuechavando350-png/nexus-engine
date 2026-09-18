import assert from 'node:assert/strict';
import {fpPowerMod, fpDiscriminant} from '../core/layers/batch-800-finite-polynomials.mjs';
let s=0xabcdef01;const rng=()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return s>>>0;};const rand=n=>rng()%n;
const mod=(x,p)=>((x%p)+p)%p;
function trim(v){let a=v.map(Number);while(a.length>1&&a.at(-1)===0)a.pop();return a;}
function product(a,b,p){let c=Array(a.length+b.length-1).fill(0);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)c[i+j]=mod(c[i+j]+a[i]*b[j],p);return trim(c);}
function rem(a,b,p){a=trim(a);b=trim(b);if(b.length===1&&b[0]===0)throw Error('zero div');let inv=0;for(let t=1;t<p;t++)if(mod(b.at(-1)*t,p)===1)inv=t;while(a.length>=b.length&&!(a.length===1&&a[0]===0)){let i=a.length-b.length,scale=mod(a.at(-1)*inv,p);for(let j=0;j<b.length;j++)a[i+j]=mod(a[i+j]-scale*b[j],p);a=trim(a);}return a;}
let passed=0,failed=[],mismatches=0;
for(let iteration=0;iteration<1500;iteration++){
 const p=[2,3,5,7][rand(4)],na=1+rand(5),nm=1+rand(5),a=Array.from({length:na},()=>rand(p)),m=Array.from({length:nm},()=>rand(p));if(m.every(x=>x===0))m[0]=1;
 const e=rand(10), input={prime:p,coefficients:a,modulus:m,exponent:e};
 let expected=rem([1],m,p);for(let k=0;k<e;k++)expected=rem(product(expected,a,p),m,p);
 const actual=fpPowerMod(input).coefficients;
 if(JSON.stringify(expected)!==JSON.stringify(actual)){mismatches++;if(failed.length<5)failed.push({input,expected,actual});}
 else passed++;
 const coeff=trim(a);if(coeff.length===3){const disc=mod(coeff[1]**2-4*coeff[0]*coeff[2],p);assert.equal(fpDiscriminant({prime:p,coefficients:coeff}).value,disc);passed++;}
}
assert.deepEqual(fpPowerMod({prime:5,coefficients:[2],modulus:[2],exponent:0}).coefficients,[0]);
assert.deepEqual(fpPowerMod({prime:5,coefficients:[2],modulus:[1,0,1],exponent:0}).coefficients,[1]);
assert.equal(mismatches,0,JSON.stringify({mismatches,examples:failed}));
console.log(JSON.stringify({status:'PASS',cases:1500,additionalChecks:passed,mismatches}));
