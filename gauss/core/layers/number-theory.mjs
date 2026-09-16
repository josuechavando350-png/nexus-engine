// Bounded exact integer algorithms: BigInt is used internally whenever an
// intermediate product might exceed IEEE-754's safe-integer range.
const check = (v, label, min, max) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(`${label} must be a safe integer in [${min},${max}]`);
  return v;
};
const frozen = value => Object.freeze(value);
const mod = (a,m) => ((a % m) + m) % m;
function egcd(a,b) {
  let oldR=a,r=b,oldS=1n,s=0n,oldT=0n,t=1n;
  while(r!==0n){const q=oldR/r;[oldR,r]=[r,oldR-q*r];[oldS,s]=[s,oldS-q*s];[oldT,t]=[t,oldT-q*t];}
  if(oldR<0n)return [-oldR,-oldS,-oldT];
  return [oldR,oldS,oldT];
}
const gcd=(a,b)=>egcd(a,b)[0];
const factor=n=>{const factors=[];let x=n;
  for(let p=2;p*p<=x;p+=p===2?1:2){if(x%p)continue;let exponent=0;while(x%p===0){x/=p;exponent++;}factors.push(frozen({prime:p,exponent}));}
  if(x>1)factors.push(frozen({prime:x,exponent:1}));return frozen(factors);
};
export function extendedEuclidean({a,b}) {
  check(a,'a',-1e9,1e9);check(b,'b',-1e9,1e9);
  if(a===0&&b===0)throw new TypeError('gcd of two zeros has no unique Bezout certificate');
  const [g,x,y]=egcd(BigInt(a),BigInt(b));
  return frozen({gcd:Number(g),bezoutX:Number(x),bezoutY:Number(y)});
}
export function modularInverse({value,modulus}) {
  check(value,'value',-1e9,1e9);check(modulus,'modulus',2,1e9);
  const [g,x]=egcd(BigInt(value),BigInt(modulus));
  if(g!==1n)throw new RangeError('modular inverse does not exist');
  return frozen({inverse:Number(mod(x,BigInt(modulus))),modulus});
}
export function pairwiseCoprimeChineseRemainder({congruences}) {
  if(!Array.isArray(congruences)||congruences.length<1||congruences.length>12)throw new TypeError('congruences length must be 1..12');
  let modulus=1n,remainder=0n;
  for(const [i,c] of congruences.entries()){
    if(!c||typeof c!=='object'||Array.isArray(c))throw new TypeError(`congruences[${i}] must be an object`);
    const m=BigInt(check(c.modulus,`congruences[${i}].modulus`,2,1e9));
    const r=BigInt(check(c.remainder,`congruences[${i}].remainder`,-1e9,1e9));
    if(gcd(modulus,m)!==1n)throw new RangeError('CRT requires pairwise coprime moduli');
    if(modulus*m>1000000000000000000n)throw new RangeError('CRT combined modulus exceeds bounded budget');
    const [,inverse]=egcd(modulus,m),correction=mod((r-remainder)*inverse,m);
    remainder=mod(remainder+modulus*correction,modulus*m);modulus*=m;
  }
  return frozen({remainder:remainder.toString(),modulus:modulus.toString()});
}
export function modularExponentiation({base,exponent,modulus}) {
  check(base,'base',-1e9,1e9);check(exponent,'exponent',0,1e9);check(modulus,'modulus',1,1e9);
  let power=mod(BigInt(base),BigInt(modulus)),n=BigInt(exponent),result=1n%BigInt(modulus),m=BigInt(modulus);
  while(n>0n){if(n&1n)result=result*power%m;power=power*power%m;n>>=1n;}
  return frozen({remainder:Number(result)});
}
export function trialDivisionFactorization({value}) {
  const n=check(value,'value',2,1e9);
  return frozen({factors:factor(n)});
}
export function eulerTotient({value}) {
  const n=check(value,'value',1,1e9);let result=n;
  for(const {prime} of n===1?[]:factor(n))result=result/prime*(prime-1);
  return frozen({totient:result});
}
export function deterministicSafeIntegerPrimality({value}) {
  const n=check(value,'value',0,Number.MAX_SAFE_INTEGER);
  if(n<2)return frozen({isPrime:false});
  const x=BigInt(n);
  // The following seven witnesses are deterministic for every unsigned 64-bit integer.
  for(const p of [2n,3n,5n,7n,11n,13n,17n,19n,23n,29n,31n,37n]){
    if(x===p)return frozen({isPrime:true});if(x%p===0n)return frozen({isPrime:false});
  }
  let d=x-1n,s=0n;while(!(d&1n)){d>>=1n;s++;}
  const pow=(base,exponent)=>{let a=base%x,out=1n;while(exponent){if(exponent&1n)out=out*a%x;a=a*a%x;exponent>>=1n;}return out;};
  for(const witness of [2n,325n,9375n,28178n,450775n,9780504n,1795265022n]){
    const a=witness%x;if(a===0n)continue;let y=pow(a,d);if(y===1n||y===x-1n)continue;
    let passed=false;for(let j=1n;j<s;j++){y=y*y%x;if(y===x-1n){passed=true;break;}}
    if(!passed)return frozen({isPrime:false});
  }
  return frozen({isPrime:true});
}
export function boundedPrimeSieve({limit}) {
  const n=check(limit,'limit',0,100000);const composite=new Uint8Array(n+1),primes=[];
  for(let p=2;p<=n;p++){if(composite[p])continue;primes.push(p);
    if(p*p<=n)for(let k=p*p;k<=n;k+=p)composite[k]=1;
  }
  return frozen({primes:frozen(primes),count:primes.length});
}
export function exactIntegerSquareRoot({value}) {
  const n=BigInt(check(value,'value',0,Number.MAX_SAFE_INTEGER));
  let lo=0n,hi=94906266n; // ceil(sqrt(Number.MAX_SAFE_INTEGER))
  while(lo<hi){const mid=(lo+hi+1n)>>1n;if(mid*mid<=n)lo=mid;else hi=mid-1n;}
  return frozen({root:Number(lo),remainder:Number(n-lo*lo)});
}
export function exactBinomialCoefficient({n,k}) {
  const rows=check(n,'n',0,1000),choose=check(k,'k',0,rows);
  let result=1n;for(let i=1;i<=Math.min(choose,rows-choose);i++)result=result*BigInt(rows-Math.min(choose,rows-choose)+i)/BigInt(i);
  return frozen({coefficient:result.toString()});
}
export function exactFibonacciFastDoubling({index}) {
  const n=check(index,'index',0,10000);
  function pair(k){if(!k)return [0n,1n];const [a,b]=pair(Math.floor(k/2));const c=a*(2n*b-a),d=a*a+b*b;return k%2?[d,c+d]:[c,d];}
  return frozen({number:pair(n)[0].toString()});
}
export function exactIntegerPartitionCount({n}) {
  const end=check(n,'n',0,300),p=Array(end+1).fill(0n);p[0]=1n;
  for(let i=1;i<=end;i++)for(let k=1;;k++){
    const a=k*(3*k-1)/2,b=k*(3*k+1)/2;if(a>i)break;
    const sign=k%2?1n:-1n;p[i]+=sign*p[i-a];if(b<=i)p[i]+=sign*p[i-b];
  }
  return frozen({partitions:p[end].toString()});
}
