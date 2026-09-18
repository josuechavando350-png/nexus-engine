// Exact, bounded combinatorial counts. Built-in BigInt; no packages or services.
const MAX_N = 32;
function integer(value, name, max=MAX_N) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${name} must be an integer in [0,${max}]`);
  return value;
}
function unary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input,'n')) throw new TypeError('expected exactly {n}');
  return integer(input.n,'n');
}
function binary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input,'n') || !Object.hasOwn(input,'k')) throw new TypeError('expected exactly {n,k}');
  return [integer(input.n,'n'),integer(input.k,'k')];
}
const out = value => Object.freeze({value:value.toString()});
function factorial(n) {let z=1n;for(let i=2;i<=n;i++)z*=BigInt(i);return z;}
function choose(n,k) {if(k<0||k>n)return 0n;k=Math.min(k,n-k);let z=1n;for(let i=1;i<=k;i++)z=z*BigInt(n-k+i)/BigInt(i);return z;}
function stirlingSecond(n,k) {
  const dp=Array(k+1).fill(0n);dp[0]=1n;
  for(let i=1;i<=n;i++)for(let j=Math.min(i,k);j>=0;j--)dp[j]=(j?dp[j-1]:0n)+BigInt(j)*dp[j];
  return dp[k];
}
function stirlingFirst(n,k) {
  const dp=Array(k+1).fill(0n);dp[0]=1n;
  for(let i=1;i<=n;i++)for(let j=Math.min(i,k);j>=0;j--)dp[j]=(j?dp[j-1]:0n)+BigInt(i-1)*dp[j];
  return dp[k];
}
function compositions(n,k,weak=false){if(!k)return n===0?1n:0n;return weak?choose(n+k-1,k-1):n?choose(n-1,k-1):0n;}
function derangement(n){let a=1n,b=0n;if(!n)return a;for(let i=2;i<=n;i++){const c=BigInt(i-1)*(a+b);a=b;b=c;}return b;}
function partition(n,selection){let d=Array(n+1).fill(0n);d[0]=1n;for(let part=1;part<=n;part++)if(selection(part))for(let sum=part;sum<=n;sum++)d[sum]+=d[sum-part];return d[n];}
export function exactStirlingSecond(input){const [n,k]=binary(input);return out(stirlingSecond(n,k));}
export function exactUnsignedStirlingFirst(input){const [n,k]=binary(input);return out(stirlingFirst(n,k));}
export function exactSignedStirlingFirst(input){const [n,k]=binary(input);const a=stirlingFirst(n,k);return out((n-k)%2?-a:a);}
export function exactBellNumber(input){const n=unary(input);let z=0n;for(let k=0;k<=n;k++)z+=stirlingSecond(n,k);return out(z);}
export function exactOrderedBellNumber(input){const n=unary(input);let z=0n;for(let k=0;k<=n;k++)z+=factorial(k)*stirlingSecond(n,k);return out(z);}
export function exactUnsignedLahNumber(input){const [n,k]=binary(input);return out(n===0&&k===0?1n:k===0?0n:choose(n-1,k-1)*factorial(n)/factorial(k));}
export function exactEulerianNumber(input){const [n,k]=binary(input);if(n===0)return out(k===0?1n:0n);let d=Array(k+1).fill(0n);d[0]=1n;for(let i=1;i<=n;i++){const next=Array(k+1).fill(0n);for(let j=0;j<=Math.min(k,i-1);j++)next[j]=BigInt(j+1)*d[j]+(j?BigInt(i-j)*d[j-1]:0n);d=next;}return out(d[k]);}
export function exactNarayanaNumber(input){const [n,k]=binary(input);return out(n===0?(k===0?1n:0n):k===0||k>n?0n:choose(n,k)*choose(n,k-1)/BigInt(n));}
export function exactCatalanNumber(input){const n=unary(input);return out(choose(2*n,n)/BigInt(n+1));}
export function exactMotzkinNumber(input){const n=unary(input);const m=[1n];for(let i=1;i<=n;i++){let z=m[i-1];for(let j=0;j<i-1;j++)z+=m[j]*m[i-2-j];m.push(z);}return out(m[n]);}
export function exactDelannoyNumber(input){const [n,k]=binary(input);const d=Array.from({length:n+1},()=>Array(k+1).fill(1n));for(let i=1;i<=n;i++)for(let j=1;j<=k;j++)d[i][j]=d[i-1][j]+d[i][j-1]+d[i-1][j-1];return out(d[n][k]);}
export function exactCentralDelannoyNumber(input){const n=unary(input);const d=Array(n+1).fill(1n);for(let i=1;i<=n;i++)for(let j=1,diagonal=1n;j<=n;j++){const old=d[j];d[j]+=d[j-1]+diagonal;diagonal=old;}return out(d[n]);}
export function exactDerangementNumber(input){return out(derangement(unary(input)));}
export function exactRencontresNumber(input){const [n,k]=binary(input);return out(choose(n,k)*derangement(n-k));}
export function exactInvolutionNumber(input){const n=unary(input);let a=1n,b=1n;for(let i=2;i<=n;i++){const c=b+BigInt(i-1)*a;a=b;b=c;}return out(n?b:a);}
export function exactPartitionsIntoKParts(input){const [n,k]=binary(input);const dp=Array.from({length:n+1},()=>Array(k+1).fill(0n));dp[0][0]=1n;for(let part=1;part<=n;part++)for(let sum=part;sum<=n;sum++)for(let count=1;count<=k;count++)dp[sum][count]+=dp[sum-part][count-1];return out(dp[n][k]);}
export function exactPartitionsDistinct(input){const n=unary(input);let dp=Array(n+1).fill(0n);dp[0]=1n;for(let p=1;p<=n;p++)for(let s=n;s>=p;s--)dp[s]+=dp[s-p];return out(dp[n]);}
export function exactPartitionsOdd(input){const n=unary(input);return out(partition(n,p=>p%2===1));}
export function exactPositiveCompositions(input){const [n,k]=binary(input);return out(compositions(n,k));}
export function exactWeakCompositions(input){const [n,k]=binary(input);return out(compositions(n,k,true));}
export function exactPalindromicCompositions(input){const n=unary(input);return out(n===0?1n:1n<<BigInt(Math.floor(n/2)));}
export function exactBinaryStringsWithoutAdjacentOnes(input){const n=unary(input);let a=1n,b=2n;for(let i=2;i<=n;i++){const c=a+b;a=b;b=c;}return out(n===0?1n:n===1?2n:b);}
export const EXACT_COMBINATORICS = Object.freeze([
 ['STIRLING_SECOND','Number of partitions of an n-element set into k unlabeled nonempty blocks',exactStirlingSecond,{n:6,k:3}],
 ['STIRLING_FIRST_UNSIGNED','Number of permutations of n elements with exactly k cycles',exactUnsignedStirlingFirst,{n:6,k:3}],
 ['STIRLING_FIRST_SIGNED','Signed first-kind Stirling coefficient of falling factorial',exactSignedStirlingFirst,{n:6,k:3}],
 ['BELL','Number of set partitions of n labeled elements',exactBellNumber,{n:6}],
 ['ORDERED_BELL','Number of ordered set partitions (weak orders)',exactOrderedBellNumber,{n:6}],
 ['LAH_UNSIGNED','Number of partitions of n labeled elements into k ordered lists',exactUnsignedLahNumber,{n:6,k:3}],
 ['EULERIAN','Number of permutations of n elements with exactly k descents',exactEulerianNumber,{n:6,k:2}],
 ['NARAYANA','Number of Dyck paths of semilength n with exactly k peaks',exactNarayanaNumber,{n:6,k:3}],
 ['CATALAN','Number of Dyck paths of semilength n',exactCatalanNumber,{n:6}],
 ['MOTZKIN','Number of Motzkin paths of length n',exactMotzkinNumber,{n:6}],
 ['DELANNOY','Number of lattice paths (0,0) to (n,k) using E,N,NE steps',exactDelannoyNumber,{n:6,k:3}],
 ['CENTRAL_DELANNOY','Number of Delannoy paths (0,0) to (n,n)',exactCentralDelannoyNumber,{n:6}],
 ['DERANGEMENT','Number of fixed-point-free permutations of n elements',exactDerangementNumber,{n:6}],
 ['RENCONTRES','Number of permutations of n elements with exactly k fixed points',exactRencontresNumber,{n:6,k:2}],
 ['INVOLUTION','Number of permutations of n elements equal to their inverse',exactInvolutionNumber,{n:6}],
 ['PARTITIONS_EXACT_K','Number of integer partitions of n with exactly k positive parts',exactPartitionsIntoKParts,{n:6,k:3}],
 ['PARTITIONS_DISTINCT','Number of integer partitions of n into distinct positive parts',exactPartitionsDistinct,{n:6}],
 ['PARTITIONS_ODD','Number of integer partitions of n into odd positive parts',exactPartitionsOdd,{n:6}],
 ['POSITIVE_COMPOSITIONS','Number of compositions of n into k positive ordered parts',exactPositiveCompositions,{n:6,k:3}],
 ['WEAK_COMPOSITIONS','Number of compositions of n into k nonnegative ordered parts',exactWeakCompositions,{n:6,k:3}],
 ['PALINDROMIC_COMPOSITIONS','Number of symmetric ordered positive compositions of n',exactPalindromicCompositions,{n:6}],
 ['BINARY_NO_ADJACENT_ONES','Number of n-bit binary strings without adjacent one bits',exactBinaryStringsWithoutAdjacentOnes,{n:6}],
].map(([code,description,execute,input],index)=>Object.freeze({id:`GAUSS.MATH.${code}.${String(201+index).padStart(3,'0')}`,domain:'MATHEMATICS',description,execute,input:Object.freeze(input)})));
