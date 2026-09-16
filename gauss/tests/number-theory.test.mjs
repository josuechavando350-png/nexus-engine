import test from 'node:test';
import assert from 'node:assert/strict';
import {
 extendedEuclidean,modularInverse,pairwiseCoprimeChineseRemainder,
 modularExponentiation,trialDivisionFactorization,eulerTotient,
 deterministicSafeIntegerPrimality,boundedPrimeSieve,exactIntegerSquareRoot,
 exactBinomialCoefficient,exactFibonacciFastDoubling,exactIntegerPartitionCount,
} from '../core/layers/number-theory.mjs';
let seed=0x79a1c0de;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2**32;}
const rand=n=>Math.floor(random()*n);
const gcd=(a,b)=>{a=Math.abs(a);b=Math.abs(b);while(b)[a,b]=[b,a%b];return a;};
const prime=n=>{if(n<2)return false;for(let p=2;p*p<=n;p++)if(n%p===0)return false;return true;};
test('extended Euclidean certificates satisfy Bezout identity and independently computed gcd',()=>{
 for(let i=0;i<350;i++){const a=rand(200001)-100000,b=rand(200001)-100000;if(!a&&!b)continue;
  const {gcd:g,bezoutX:x,bezoutY:y}=extendedEuclidean({a,b});assert.equal(g,gcd(a,b));assert.equal(a*x+b*y,g);}
});
test('modular inverses match independent linear brute force on bounded coprime pairs',()=>{
 for(let i=0;i<260;i++){const m=2+rand(99),v=rand(201)-100;
  if(gcd(v,m)!==1){assert.throws(()=>modularInverse({value:v,modulus:m}),/does not exist/);continue;}
  const expected=Array.from({length:m},(_,j)=>j).find(j=>((v*j)%m+m)%m===1);
  assert.equal(modularInverse({value:v,modulus:m}).inverse,expected);
 }
});
test('pairwise-coprime Chinese remainder agrees with independent bounded search',()=>{
 const primes=[2,3,5,7,11];
 for(let i=0;i<230;i++){
  const subset=primes.filter(()=>rand(2)===1).slice(0,4);if(!subset.length)subset.push(2);
  const congruences=subset.map(modulus=>({modulus,remainder:rand(101)-50}));
  const product=subset.reduce((a,b)=>a*b,1),found=Array.from({length:product},(_,j)=>j).find(x=>congruences.every(c=>((x-c.remainder)%c.modulus+c.modulus)%c.modulus===0));
  const out=pairwiseCoprimeChineseRemainder({congruences});assert.equal(out.modulus,String(product));assert.equal(out.remainder,String(found));
 }
 assert.throws(()=>pairwiseCoprimeChineseRemainder({congruences:[{modulus:4,remainder:1},{modulus:6,remainder:3}]}),/coprime/);
 assert.throws(()=>pairwiseCoprimeChineseRemainder({congruences:Array.from({length:12},()=>({modulus:999999937,remainder:1}))}),/coprime|budget/);
});
test('binary modular exponentiation equals independently repeated modular multiplication',()=>{
 for(let i=0;i<280;i++){const base=rand(401)-200,n=rand(90),modulus=1+rand(200);let expected=1n%BigInt(modulus);
  const b=((BigInt(base)%BigInt(modulus))+BigInt(modulus))%BigInt(modulus);
  for(let j=0;j<n;j++)expected=expected*b%BigInt(modulus);
  assert.equal(modularExponentiation({base,exponent:n,modulus}).remainder,Number(expected));
 }
});
test('factorization reconstructs integer and produces only prime factors',()=>{
 for(let i=0;i<320;i++){
  const n=2+rand(100000),rows=trialDivisionFactorization({value:n}).factors;
  assert(rows.every(row=>prime(row.prime)&&row.exponent>0));
  assert.equal(rows.reduce((p,row)=>p*row.prime**row.exponent,1),n);
  assert(rows.every((row,j)=>!j||rows[j-1].prime<row.prime));
 }
});
test('Euler totient equals independent coprimality enumeration',()=>{
 for(let n=1;n<=300;n++){
  const count=Array.from({length:n},(_,i)=>i+1).filter(k=>gcd(n,k)===1).length;
  assert.equal(eulerTotient({value:n}).totient,count);
 }
});
test('deterministic primality agrees with independent trial division and rejects strong pseudoprimes',()=>{
 for(let n=0;n<=16000;n++)assert.equal(deterministicSafeIntegerPrimality({value:n}).isPrime,prime(n),String(n));
 for(const n of [341,561,1105,1729,2047,3215031751,341550071728321])assert.equal(deterministicSafeIntegerPrimality({value:n}).isPrime,false,String(n));
 assert.equal(deterministicSafeIntegerPrimality({value:2147483647}).isPrime,true);
});
test('prime sieve matches independent trial-division oracle over 0..800',()=>{
 for(let n=0;n<=800;n+=1+rand(10)){
  const got=boundedPrimeSieve({limit:n});const expected=Array.from({length:n+1},(_,i)=>i).filter(prime);
  assert.deepEqual(got.primes,expected);assert.equal(got.count,expected.length);
 }
});
test('integer square root supplies exact floor witness even at safe integer boundary',()=>{
 for(let i=0;i<500;i++){
  const n=i<450?rand(1000000000):Number.MAX_SAFE_INTEGER-rand(100000000);
  const {root,remainder}=exactIntegerSquareRoot({value:n}),r=BigInt(root),value=BigInt(n);
  assert(r*r<=value && (r+1n)*(r+1n)>value);
  assert.equal(BigInt(remainder),value-r*r);
 }
});
test('exact binomial coefficient agrees with independent Pascal recursion',()=>{
 const rows=[[1n]];
 for(let n=0;n<=100;n++){
  if(n){const prev=rows[n-1];rows.push(Array.from({length:n+1},(_,k)=>(k?prev[k-1]??0n:0n)+(prev[k]??0n)));}
  for(let k=0;k<=n;k++)assert.equal(exactBinomialCoefficient({n,k}).coefficient,rows[n][k].toString());
 }
 assert.equal(exactBinomialCoefficient({n:1000,k:500}).coefficient,exactBinomialCoefficient({n:1000,k:500}).coefficient);
});
test('fast doubling Fibonacci agrees with separate linear-time recurrence',()=>{
 let a=0n,b=1n;for(let n=0;n<=1400;n++){
  assert.equal(exactFibonacciFastDoubling({index:n}).number,a.toString());[a,b]=[b,a+b];
 }
});
test('integer partition recurrence matches exhaustive denomination recursion',()=>{
 const oracle=(n,max,memo=new Map())=>{
  if(n===0)return 1n;if(n<0||max===0)return 0n;
  const key=`${n},${max}`;if(memo.has(key))return memo.get(key);
  const v=oracle(n,max-1,memo)+oracle(n-max,max,memo);memo.set(key,v);return v;
 };
 for(let n=0;n<=32;n++)assert.equal(exactIntegerPartitionCount({n}).partitions,oracle(n,n).toString());
 assert(exactIntegerPartitionCount({n:300}).partitions.length>10);
});
test('number-theory operations reject invalid or over-budget inputs without false exactness',()=>{
 assert.throws(()=>extendedEuclidean({a:0,b:0}),/zeros/);
 assert.throws(()=>modularInverse({value:2,modulus:4}),/does not exist/);
 assert.throws(()=>pairwiseCoprimeChineseRemainder({congruences:[]}),/length/);
 assert.throws(()=>modularExponentiation({base:2,exponent:-1,modulus:5}),/integer/);
 assert.throws(()=>trialDivisionFactorization({value:1}),/integer/);
 assert.throws(()=>eulerTotient({value:Infinity}),/integer/);
 assert.throws(()=>deterministicSafeIntegerPrimality({value:Number.MAX_SAFE_INTEGER+1}),/integer/);
 assert.throws(()=>boundedPrimeSieve({limit:100001}),/integer/);
 assert.throws(()=>exactIntegerSquareRoot({value:-1}),/integer/);
 assert.throws(()=>exactBinomialCoefficient({n:3,k:4}),/integer/);
 assert.throws(()=>exactFibonacciFastDoubling({index:10001}),/integer/);
 assert.throws(()=>exactIntegerPartitionCount({n:301}),/integer/);
});
