// GAUSS 221–240. Exact bounded integer number-theory operators.
function nat(v,n,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<0||v>max)throw new RangeError(`${n} must be a safe integer in [0,${max}]`);return v;}
function pos(v,n,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<1||v>max)throw new RangeError(`${n} must be a safe integer in [1,${max}]`);return v;}
function gcd2(a,b){a=BigInt(a);b=BigInt(b);while(b){const t=a%b;a=b;b=t;}return a<0n?-a:a;}
function powmod(a,e,m){let x=BigInt(a)%BigInt(m),n=BigInt(e),r=1n,mod=BigInt(m);while(n){if(n&1n)r=r*x%mod;x=x*x%mod;n>>=1n;}return r;}
function factor(n){let x=n,out=[];for(let p=2;p*p<=x;p+=p===2?1:2){if(x%p)continue;let e=0;while(x%p===0){x/=p;e++;}out.push([p,e]);}if(x>1)out.push([x,1]);return out;}
export function gcd({a,b}){nat(a,'a');nat(b,'b');return{a,b,value:gcd2(a,b).toString()};}
export function lcm({a,b}){nat(a,'a');nat(b,'b');if(a===0||b===0)return{a,b,value:'0'};return{a,b,value:(BigInt(a)/gcd2(a,b)*BigInt(b)).toString()};}
export function extendedGcd({a,b}){pos(a,'a');pos(b,'b');let or=BigInt(a),r=BigInt(b),os=1n,s=0n,ot=0n,t=1n;while(r){const q=or/r;[or,r]=[r,or-q*r];[os,s]=[s,os-q*s];[ot,t]=[t,ot-q*t];}return{a,b,gcd:or.toString(),x:os.toString(),y:ot.toString()};}
export function modularPower({base,exponent,modulus}){nat(base,'base');nat(exponent,'exponent');pos(modulus,'modulus');return{base,exponent,modulus,value:powmod(base,exponent,modulus).toString()};}
export function modularInverse({a,modulus}){pos(a,'a');pos(modulus,'modulus');const r=extendedGcd({a, b:modulus});if(r.gcd!=='1')return{a,modulus,exists:false,value:null};let x=BigInt(r.x)%BigInt(modulus);if(x<0)x+=BigInt(modulus);return{a,modulus,exists:true,value:x.toString()};}
export function eulerTotient({n}){pos(n,'n',1_000_000_000);let r=BigInt(n);for(const[p]of factor(n))r=r/BigInt(p)*BigInt(p-1);return{n,value:r.toString()};}
export function mobius({n}){pos(n,'n',1_000_000_000);const f=factor(n);if(f.some(([,e])=>e>1))return{n,value:0};return{n,value:f.length%2?-1:1};}
export function radical({n}){pos(n,'n',1_000_000_000);let r=1n;for(const[p]of factor(n))r*=BigInt(p);return{n,value:r.toString()};}
export function divisorCount({n}){pos(n,'n',1_000_000_000);let r=1n;for(const[,e]of factor(n))r*=BigInt(e+1);return{n,value:r.toString()};}
export function divisorSum({n}){pos(n,'n',1_000_000_000);let r=1n;for(const[p,e]of factor(n)){let s=1n,q=1n;for(let i=0;i<e;i++){q*=BigInt(p);s+=q;}r*=s;}return{n,value:r.toString()};}
export function properDivisorSum({n}){const r=divisorSum({n});return{n,value:(BigInt(r.value)-BigInt(n)).toString()};}
export function isPerfectNumber({n}){pos(n,'n',1_000_000_000);return{n,value:properDivisorSum({n}).value===String(n)};}
export function isAbundantNumber({n}){pos(n,'n',1_000_000_000);return{n,value:BigInt(properDivisorSum({n}).value)>BigInt(n)};}
export function isDeficientNumber({n}){pos(n,'n',1_000_000_000);return{n,value:BigInt(properDivisorSum({n}).value)<BigInt(n)};}
export function primeFactorization({n}){pos(n,'n',1_000_000_000);return{n,factors:factor(n).map(([prime,exponent])=>({prime,exponent}))};}
export function squareFreeKernel({n}){pos(n,'n',1_000_000_000);let r=1n;for(const[p,e]of factor(n))if(e%2)r*=BigInt(p);return{n,value:r.toString()};}
export function carmichaelLambda({n}){pos(n,'n',1_000_000_000);let l=1n;for(const[p,e]of factor(n)){let term;if(p===2&&e>=3)term=1n<<BigInt(e-2);else term=BigInt(p-1)*BigInt(p)**BigInt(e-1);l=l/gcd2(l,term)*term;}return{n,value:l.toString()};}
export function multiplicativeOrder({a,modulus}){pos(a,'a');pos(modulus,'modulus',1_000_000);if(gcd2(a,modulus)!==1n)return{a,modulus,exists:false,value:null};const phi=Number(eulerTotient({n:modulus}).value);for(let d=1;d<=phi;d++)if(phi%d===0&&powmod(a,d,modulus)===1n)return{a,modulus,exists:true,value:d};throw new Error('order invariant violated');}
export function chineseRemainderPair({a,m,b,n}){nat(a,'a');pos(m,'m');nat(b,'b');pos(n,'n');const g=gcd2(m,n),diff=BigInt(b)-BigInt(a);if(diff%g!==0n)return{a,m,b,n,exists:false,value:null,modulus:null};const m1=BigInt(m)/g,n1=BigInt(n)/g,inv=BigInt(modularInverse({a:Number(m1%n1),modulus:Number(n1)}).value);let k=(diff/g*inv)%n1;if(k<0)k+=n1;const mod=BigInt(m)*n1;let x=(BigInt(a)+BigInt(m)*k)%mod;if(x<0)x+=mod;return{a,m,b,n,exists:true,value:x.toString(),modulus:mod.toString()};}
export function legendreSymbol({a,p}){nat(a,'a');pos(p,'p',1_000_000_000);if(p===2||factor(p).length!==1||factor(p)[0][1]!==1)throw new RangeError('p must be an odd prime');const r=powmod(a,(p-1)/2,p);return{a,p,value:r===0n?0:r===1n?1:-1};}
export const BATCH_500_NUMBER_THEORY_OPERATORS=Object.freeze([
['GAUSS.MATH.GCD.221',gcd],['GAUSS.MATH.LCM.222',lcm],['GAUSS.MATH.EXTENDED_GCD.223',extendedGcd],['GAUSS.MATH.MODULAR_POWER.224',modularPower],['GAUSS.MATH.MODULAR_INVERSE.225',modularInverse],['GAUSS.MATH.EULER_TOTIENT.226',eulerTotient],['GAUSS.MATH.MOBIUS.227',mobius],['GAUSS.MATH.RADICAL.228',radical],['GAUSS.MATH.DIVISOR_COUNT.229',divisorCount],['GAUSS.MATH.DIVISOR_SUM.230',divisorSum],['GAUSS.MATH.PROPER_DIVISOR_SUM.231',properDivisorSum],['GAUSS.MATH.IS_PERFECT.232',isPerfectNumber],['GAUSS.MATH.IS_ABUNDANT.233',isAbundantNumber],['GAUSS.MATH.IS_DEFICIENT.234',isDeficientNumber],['GAUSS.MATH.PRIME_FACTORIZATION.235',primeFactorization],['GAUSS.MATH.SQUARE_FREE_KERNEL.236',squareFreeKernel],['GAUSS.MATH.CARMICHAEL_LAMBDA.237',carmichaelLambda],['GAUSS.MATH.MULTIPLICATIVE_ORDER.238',multiplicativeOrder],['GAUSS.MATH.CRT_PAIR.239',chineseRemainderPair],['GAUSS.MATH.LEGENDRE_SYMBOL.240',legendreSymbol]
].map(([id,execute])=>Object.freeze({id,domain:'MATHEMATICS',execute})));
