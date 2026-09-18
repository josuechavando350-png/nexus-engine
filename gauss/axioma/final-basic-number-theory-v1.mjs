/* Independent small-integer enumeration; Bezout certificates verified by mathematical identity. */
import assert from 'node:assert/strict';
import {runFinalBank,range} from './final-common-v1.mjs';
const tags=['EXTENDED_EUCLID','MODULAR_INVERSE','CRT_COPRIME','MODULAR_EXPONENT','PRIME_FACTORIZATION','EULER_TOTIENT','PRIMALITY_SAFE_INT','PRIME_SIEVE','INTEGER_SQRT','BINOMIAL_EXACT','FIBONACCI_DOUBLING','INTEGER_PARTITIONS'];
const gcd=(a,b)=>b?gcd(b,a%b):Math.abs(a);
const prime=n=>n>1&&range(Math.floor(Math.sqrt(n))-1).every(i=>n%(i+2)!==0);
const factors=n=>{const list=[];for(let p=2;p<=n;p++)if(prime(p)&&n%p===0){let exponent=0;while(n%p===0){n/=p;exponent++;}list.push({prime:p,exponent});}return list;};
const partitions=n=>{function go(left,min){if(left===0)return 1n;let ways=0n;for(let j=min;j<=left;j++)ways+=go(left-j,j);return ways;}return go(n,1);};
const choose=(n,k)=>{const row=range(n+1).map(()=>0n);row[0]=1n;for(let i=1;i<=n;i++)for(let j=i;j>=1;j--)row[j]+=row[j-1];return row[k];};
function ref(tag,x){switch(tag){
 case 'EXTENDED_EUCLID':return {gcd:gcd(x.a,x.b)};
 case 'MODULAR_INVERSE':{const n=((x.value%x.modulus)+x.modulus)%x.modulus;for(let j=0;j<x.modulus;j++)if(n*j%x.modulus===1)return {inverse:j,modulus:x.modulus};throw Error('input coprime invariant violated');}
 case 'CRT_COPRIME':{const total=x.congruences.reduce((a,c)=>a*c.modulus,1);for(let j=0;j<total;j++)if(x.congruences.every(({remainder,modulus})=>((j-remainder)%modulus+modulus)%modulus===0))return {remainder:String(j),modulus:String(total)};throw Error('CRT oracle failed');}
 case 'MODULAR_EXPONENT':return {remainder:Number(((BigInt(x.base)**BigInt(x.exponent))%BigInt(x.modulus)+BigInt(x.modulus))%BigInt(x.modulus))};
 case 'PRIME_FACTORIZATION':return {factors:factors(x.value)};
 case 'EULER_TOTIENT':return {totient:range(x.value).filter(i=>gcd(i+1,x.value)===1).length};
 case 'PRIMALITY_SAFE_INT':return {isPrime:prime(x.value)};
 case 'PRIME_SIEVE':{const primes=range(x.limit+1).filter(prime);return {primes,count:primes.length};}
 case 'INTEGER_SQRT':{const value=BigInt(x.value);let lo=0n;while((lo+1n)*(lo+1n)<=value)lo++;return {root:Number(lo),remainder:Number(value-lo*lo)};}
 case 'BINOMIAL_EXACT':return {coefficient:String(choose(x.n,x.k))};
 case 'FIBONACCI_DOUBLING':{let a=0n,b=1n;for(let j=0;j<x.index;j++)[a,b]=[b,a+b];return {number:String(a)};}
 case 'INTEGER_PARTITIONS':return {partitions:String(partitions(x.n))};
 default:throw Error('missing exact integer reference '+tag);
 }}
function sample(tag,i,r){switch(tag){
 case 'EXTENDED_EUCLID':return {a:r(301)-150,b:r(301)-150||1};
 case 'MODULAR_INVERSE':{const m=2+r(42);let value=1+r(95);while(gcd(value,m)!==1)value++;return {value,modulus:m};}
 case 'CRT_COPRIME':{const moduli=[3,4,5].slice(0,1+r(3));return {congruences:moduli.map(modulus=>({modulus,remainder:r(2*modulus)-modulus}))};}
 case 'MODULAR_EXPONENT':return {base:r(19)-9,exponent:r(16),modulus:1+r(24)};
 case 'PRIME_FACTORIZATION':return {value:2+r(600)};
 case 'EULER_TOTIENT':return {value:1+r(180)};
 case 'PRIMALITY_SAFE_INT':return {value:r(1200)};
 case 'PRIME_SIEVE':return {limit:r(151)};
 case 'INTEGER_SQRT':return {value:r(200000)};
 case 'BINOMIAL_EXACT':{const n=r(40);return {n,k:r(n+1)};}
 case 'FIBONACCI_DOUBLING':return {index:r(100)};
 case 'INTEGER_PARTITIONS':return {n:r(19)};
 default:throw Error('no test case '+tag);
 }}
const definitions=tags.map((tag,index)=>({id:`GAUSS.MATH.${tag}.${String(10+index).padStart(3,'0')}`,make:(i,r)=>sample(tag,i,r),reference:x=>ref(tag,x),...(tag==='EXTENDED_EUCLID'?{verify:(actual,expected,input)=>{assert.equal(actual.gcd,expected.gcd);assert.ok(Number.isSafeInteger(actual.bezoutX)&&Number.isSafeInteger(actual.bezoutY));assert.equal(BigInt(input.a)*BigInt(actual.bezoutX)+BigInt(input.b)*BigInt(actual.bezoutY),BigInt(expected.gcd));}}:{})}));
export const runFinalBasicNumberTheoryBank=options=>runFinalBank({name:'AXIOMA 12 small-integer exact number-theory references',definitions,...options});
