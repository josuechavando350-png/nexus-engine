// Integer-only, bounded finite arithmetic. No packages, network, secrets or floats.
function check(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length || keys.some(k=>!Object.hasOwn(input,k))) throw new TypeError(`expected exactly {${keys.join(',')}}`);
  for (const key of keys) if (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > (key==='n'?200:32)) throw new TypeError(`${key} out of supported integer range`);
  return input;
}
const single = input => check(input,['n']).n;
const pair = input => check(input,['n','k']);
const out = value => Object.freeze({value:String(value)});
function gcd(a,b){while(b){[a,b]=[b,a%b];}return a;}
function divisors(n){if(!n)throw new RangeError('n must be positive');const d=[];for(let i=1;i<=n;i++)if(n%i===0)d.push(i);return d;}
function factor(n){if(!n)throw new RangeError('n must be positive');let m=n;const a=[];for(let p=2;p*p<=m;p++)if(m%p===0){let e=0;while(m%p===0){m/=p;e++;}a.push([p,e]);}if(m>1)a.push([m,1]);return a;}
function mobius(n){return factor(n).some(([,e])=>e>1)?0:factor(n).length%2?-1:1;}
function phi(n){let z=n;for(const [p] of factor(n))z=z/p*(p-1);return z;}
function pow(x,e){return BigInt(x)**BigInt(e);}
function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let a=1n;for(let i=1;i<=k;i++)a=a*BigInt(n-k+i)/BigInt(i);return a;}
function prime(n){if(n<2)return false;for(let j=2;j*j<=n;j++)if(n%j===0)return false;return true;}
function order(base,n){let x=1,r=base%n;for(let k=1;k<=phi(n);k++){x=x*r%n;if(x===1)return k;}return null;}
export function exactMobiusSummatory(input){const n=single(input);let z=0;for(let i=1;i<=n;i++)z+=mobius(i);return out(z);}
export function exactTotientSummatory(input){const n=single(input);let z=0n;for(let i=1;i<=n;i++)z+=BigInt(phi(i));return out(z);}
export function exactDivisorSummatory(input){const n=single(input);let z=0n;for(let i=1;i<=n;i++)z+=BigInt(divisors(i).length);return out(z);}
export function exactSumOfGcdWithModulus(input){const n=single(input);return out(divisors(n).reduce((s,d)=>s+BigInt(d)*BigInt(phi(n/d)),0n));}
export function exactSumOfPairwiseGcd(input){const n=single(input);let z=0n;for(let i=1;i<=n;i++)for(let j=1;j<i;j++)z+=BigInt(gcd(i,j));return out(z);}
export function exactSumOfPairwiseLcm(input){const n=single(input);let z=0n;for(let i=1;i<=n;i++)for(let j=1;j<i;j++)z+=BigInt(i/gcd(i,j))*BigInt(j);return out(z);}
export function exactSquarefreeCount(input){const n=single(input);let z=0;for(let i=1;i<=n;i++)if(mobius(i))z++;return out(z);}
export function exactDistinctPrimeFactorCount(input){const n=single(input);return out(factor(n).length);}
export function exactPrimeFactorMultiplicity(input){const n=single(input);return out(factor(n).reduce((s,[,e])=>s+e,0));}
export function exactIntegerRadical(input){const n=single(input);return out(factor(n).reduce((s,[p])=>s*BigInt(p),1n));}
export function exactLiouvilleFunction(input){const n=single(input);return out(factor(n).reduce((s,[,e])=>s+e,0)%2?-1:1);}
export function exactUnitaryDivisorCount(input){const n=single(input);return out(1n<<BigInt(factor(n).length));}
export function exactUnitaryDivisorSum(input){const n=single(input);return out(factor(n).reduce((z,[p,e])=>z*(1n+pow(p,e)),1n));}
export function exactDivisorSquareSum(input){const n=single(input);return out(divisors(n).reduce((z,d)=>z+pow(d,2),0n));}
export function exactDivisorCubeSum(input){const n=single(input);return out(divisors(n).reduce((z,d)=>z+pow(d,3),0n));}
export function exactJordanTotientTwo(input){const n=single(input);return out(factor(n).reduce((z,[p])=>z*(BigInt(p*p)-1n)/BigInt(p*p),pow(n,2)));}
export function exactJordanTotientThree(input){const n=single(input);return out(factor(n).reduce((z,[p])=>z*(pow(p,3)-1n)/pow(p,3),pow(n,3)));}
export function exactFareySequenceLength(input){const n=single(input);let z=1n;for(let d=1;d<=n;d++)z+=BigInt(phi(d));return out(z);}
export function exactBinaryPrimitiveWords(input){const n=single(input);if(!n)throw new RangeError('n must be positive');let z=0n;for(const d of divisors(n))z+=BigInt(mobius(d))*pow(2,n/d);return out(z);}
export function exactNecklaces(input){const {n,k}=pair(input);if(!n)throw new RangeError('n must be positive');let z=0n;for(const d of divisors(n))z+=BigInt(phi(d))*pow(k,n/d);return out(z/BigInt(n));}
export function exactPrimitiveNecklaces(input){const {n,k}=pair(input);if(!n)throw new RangeError('n must be positive');let z=0n;for(const d of divisors(n))z+=BigInt(mobius(d))*pow(k,n/d);return out(z/BigInt(n));}
export function exactBracelets(input){const {n,k}=pair(input);if(!n)throw new RangeError('n must be positive');let rotations=0n;for(const d of divisors(n))rotations+=BigInt(phi(d))*pow(k,n/d);const reflections=n%2?BigInt(n)*pow(k,(n+1)/2):BigInt(n/2)*(pow(k,n/2)+pow(k,n/2+1));return out((rotations+reflections)/BigInt(2*n));}
export function exactBinaryNecklacesWithWeight(input){const {n,k}=pair(input);if(!n)throw new RangeError('n must be positive');if(k>n)return out(0n);let z=0n;for(const d of divisors(gcd(n,k)))z+=BigInt(phi(d))*choose(n/d,k/d);return out(z/BigInt(n));}
export function exactRamanujanSum(input){const {n,k}=pair(input);if(!n)throw new RangeError('n must be positive');let z=0n;for(const d of divisors(gcd(n,k)))z+=BigInt(d*mobius(n/d));return out(z);}
export function exactNthPrime(input){const n=single(input);if(n===0)throw new RangeError('n must be positive');let count=0;for(let i=2;i<2000;i++)if(prime(i)&&++count===n)return out(i);throw new RangeError('prime search budget exhausted');}
export function exactQuadraticResidueCount(input){const n=single(input);if(!n)throw new RangeError('n must be positive');const a=new Set();for(let i=0;i<n;i++)a.add(i*i%n);return out(a.size);}
export function exactPrimitiveRootCount(input){const n=single(input);if(n<2)throw new RangeError('n must be >= 2');let z=0;for(let i=1;i<n;i++)if(gcd(i,n)===1&&order(i,n)===phi(n))z++;return out(z);}
export const EXACT_NUMBER_THEORY = Object.freeze([
 ['MERTENS','Mertens summatory Möbius function',exactMobiusSummatory,{n:12}],
 ['TOTIENT_SUM','Summatory Euler totient',exactTotientSummatory,{n:12}],
 ['DIVISOR_COUNT_SUM','Summatory divisor-count function',exactDivisorSummatory,{n:12}],
 ['GCD_SUM_MODULUS','Sum of gcd(i,n), i=1..n',exactSumOfGcdWithModulus,{n:12}],
 ['GCD_PAIR_SUM','Sum of gcd(i,j) over 1<=j<i<=n',exactSumOfPairwiseGcd,{n:12}],
 ['LCM_PAIR_SUM','Sum of lcm(i,j) over 1<=j<i<=n',exactSumOfPairwiseLcm,{n:12}],
 ['SQUAREFREE_COUNT','Count of squarefree integers in [1,n]',exactSquarefreeCount,{n:12}],
 ['DISTINCT_PRIME_FACTORS','Count of distinct prime factors of n',exactDistinctPrimeFactorCount,{n:12}],
 ['PRIME_FACTORS_MULTIPLICITY','Count of prime factors with multiplicity',exactPrimeFactorMultiplicity,{n:12}],
 ['INTEGER_RADICAL','Product of distinct prime factors',exactIntegerRadical,{n:12}],
 ['LIOUVILLE','Liouville parity function',exactLiouvilleFunction,{n:12}],
 ['UNITARY_DIVISOR_COUNT','Count of divisors d with gcd(d,n/d)=1',exactUnitaryDivisorCount,{n:12}],
 ['UNITARY_DIVISOR_SUM','Sum of unitary divisors of n',exactUnitaryDivisorSum,{n:12}],
 ['SIGMA_2','Sum of squares of divisors of n',exactDivisorSquareSum,{n:12}],
 ['SIGMA_3','Sum of cubes of divisors of n',exactDivisorCubeSum,{n:12}],
 ['JORDAN_TOTIENT_2','Jordan totient J2(n)',exactJordanTotientTwo,{n:12}],
 ['JORDAN_TOTIENT_3','Jordan totient J3(n)',exactJordanTotientThree,{n:12}],
 ['FAREY_LENGTH','Number of reduced fractions from 0/1 to 1/1 with denominator <=n',exactFareySequenceLength,{n:12}],
 ['BINARY_PRIMITIVE_WORDS','Binary words with least period exactly n',exactBinaryPrimitiveWords,{n:12}],
 ['NECKLACES','Cyclic equivalence classes of k-color strings of length n',exactNecklaces,{n:12,k:3}],
 ['PRIMITIVE_NECKLACES','Aperiodic cyclic equivalence classes of k-color strings',exactPrimitiveNecklaces,{n:12,k:3}],
 ['BRACELETS','Dihedral equivalence classes of k-color strings',exactBracelets,{n:12,k:3}],
 ['BINARY_NECKLACES_WEIGHT','Binary necklaces with exactly k set bits',exactBinaryNecklacesWithWeight,{n:12,k:3}],
 ['RAMANUJAN_SUM','Exact integer Ramanujan exponential sum c_n(k)',exactRamanujanSum,{n:12,k:3}],
 ['NTH_PRIME','The nth prime for bounded n',exactNthPrime,{n:12}],
 ['QUADRATIC_RESIDUE_COUNT','Number of square residues modulo n including zero',exactQuadraticResidueCount,{n:12}],
 ['PRIMITIVE_ROOT_COUNT','Number of elements of multiplicative order phi(n)',exactPrimitiveRootCount,{n:12}],
].map(([code,description,execute,input],index)=>Object.freeze({id:`GAUSS.MATH.${code}.${String(223+index).padStart(3,'0')}`,domain:'MATHEMATICS',description,execute,input:Object.freeze(input)})));
