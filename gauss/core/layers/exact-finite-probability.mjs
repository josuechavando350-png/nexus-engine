// Exact finite equally likely sample-space events, with BigInt reduced fractions.
function check(x, keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))throw new TypeError(`expected exactly ${keys}`);for(const key of keys)if(!Number.isSafeInteger(x[key])||x[key]<0||x[key]>(key==='n'?20:12))throw new TypeError(`${key} must be bounded nonnegative integer`);return x;}
const coin=x=>check(x,['n','k']);
function balls(x,extra=false){const a=check(x,extra?['n','m','k']:['n','m']);if(!a.m)throw new RangeError('m must be positive');if(a.n>12)throw new RangeError('occupancy enumeration budget n<=12');return a;}
function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
function rational(a,b){if(b<=0n||a<0n||a>b)throw new RangeError('invalid event count');const d=gcd(a,b);return Object.freeze({numerator:String(a/d),denominator:String(b/d)});}
const power=(a,n)=>BigInt(a)**BigInt(n);
function choose(n,k){if(k<0||k>n)return 0n;k=Math.min(k,n-k);let a=1n;for(let i=1;i<=k;i++)a=a*BigInt(n-k+i)/BigInt(i);return a;}
function fact(n){let v=1n;for(let i=2;i<=n;i++)v*=BigInt(i);return v;}
function falling(n,k){let v=1n;for(let i=0;i<k;i++)v*=BigInt(n-i);return k>n?0n:v;}
function stirling(n,k){let d=Array(k+1).fill(0n);d[0]=1n;for(let i=1;i<=n;i++)for(let j=Math.min(k,i);j>=0;j--)d[j]=(j?d[j-1]:0n)+BigInt(j)*d[j];return d[k];}
function coinEvent(n,event){let d=new Map([['0,0',1n]]);for(let i=0;i<n;i++){const next=new Map();for(const [key,count] of d){const [state,used]=key.split(',').map(Number);for(let bit=0;bit<=1;bit++){const [updated,flag]=event(state,bit,i,used);if(flag<0)continue;const tag=`${updated},${flag}`;next.set(tag,(next.get(tag)||0n)+count);}}d=next;}return d;}
export function exactCoinExactlyKHeads(input){const {n,k}=coin(input);return rational(choose(n,k),power(2,n));}
export function exactCoinAtMostKHeads(input){const {n,k}=coin(input);let a=0n;for(let i=0;i<=Math.min(k,n);i++)a+=choose(n,i);return rational(a,power(2,n));}
export function exactCoinAtLeastKHeads(input){const {n,k}=coin(input);let a=0n;for(let i=k;i<=n;i++)a+=choose(n,i);return rational(a,power(2,n));}
export function exactCoinExactlyKRuns(input){const {n,k}=coin(input);return rational(n===0?BigInt(k===0):k===0?0n:2n*choose(n-1,k-1),power(2,n));}
export function exactCoinFirstHeadAtK(input){const {n,k}=coin(input);return rational(k>=1&&k<=n?power(2,n-k):0n,power(2,n));}
export function exactCoinLastHeadAtK(input){const {n,k}=coin(input);return rational(k>=1&&k<=n?power(2,k-1):0n,power(2,n));}
export function exactCoinMaxOnesRun(input){const {n,k}=coin(input);let d=Array(k+1).fill(0n);d[0]=1n;for(let i=0;i<n;i++){const next=Array(k+1).fill(0n);const sum=d.reduce((a,b)=>a+b,0n);next[0]=sum;for(let j=0;j<k;j++)next[j+1]+=d[j];d=next;}return rational(d.reduce((a,b)=>a+b,0n),power(2,n));}
export function exactCoinExactlyKAdjacentOnes(input){const {n,k}=coin(input);const d=coinEvent(n,(last,bit,i,count)=>[bit,count+Number(i>0&&last===1&&bit===1)]);let a=0n;for(const [s,v] of d)if(Number(s.split(',')[1])===k)a+=v;return rational(a,power(2,n));}
export function exactCoinExactlyKZeroOneTransitions(input){const {n,k}=coin(input);const d=coinEvent(n,(last,bit,i,count)=>[bit,count+Number(i>0&&last===0&&bit===1)]);let a=0n;for(const [s,v] of d)if(Number(s.split(',')[1])===k)a+=v;return rational(a,power(2,n));}
export function exactCoinNoAdjacentKHeads(input){const {n,k}=coin(input);return rational(k>n?0n:choose(n-k+1,k),power(2,n));}
export function exactWalkFinalDisplacement(input){const {n,k}=coin(input);return rational(k>n||(n+k)%2?0n:choose(n,(n+k)/2),power(2,n));}
export function exactWalkMaximumAtMostK(input){const {n,k}=coin(input);let d=new Map([[0,1n]]);for(let i=0;i<n;i++){const next=new Map();for(const [pos,count] of d)for(const step of [-1,1])if(pos+step<=k)next.set(pos+step,(next.get(pos+step)||0n)+count);d=next;}return rational([...d.values()].reduce((a,b)=>a+b,0n),power(2,n));}
export function exactWalkFirstReturnAtN(input){const {n,k}=coin(input);if(k!==0)throw new TypeError('k must be zero for the first return event');if(n===0||n%2)return rational(0n,power(2,n));const m=n/2;return rational(2n*choose(2*m-2,m-1)/BigInt(m),power(2,n));}
export function exactOccupancyNoCollisions(input){const {n,m}=balls(input);return rational(falling(m,n),power(m,n));}
export function exactOccupancyAtLeastOneCollision(input){const {n,m}=balls(input);const total=power(m,n);return rational(total-falling(m,n),total);}
export function exactOccupancyAllBinsSeen(input){const {n,m}=balls(input);let count=0n;for(let j=0;j<=m;j++)count+=(j%2?-1n:1n)*choose(m,j)*power(m-j,n);return rational(count,power(m,n));}
export function exactOccupancyExactlyKNonempty(input){const {n,m,k}=balls(input,true);return rational(choose(m,k)*fact(k)*stirling(n,k),power(m,n));}
export function exactOccupancyFixedBinEmpty(input){const {n,m}=balls(input);return rational(power(m-1,n),power(m,n));}
export function exactOccupancyFixedBinExactlyK(input){const {n,m,k}=balls(input,true);return rational(k>n?0n:choose(n,k)*power(m-1,n-k),power(m,n));}
export function exactOccupancyFixedBinAtLeastK(input){const {n,m,k}=balls(input,true);let count=0n;for(let j=k;j<=n;j++)count+=choose(n,j)*power(m-1,n-j);return rational(count,power(m,n));}
export function exactOccupancyEqualBins(input){const {n,m}=balls(input);if(n%m)return rational(0n,power(m,n));const per=n/m;return rational(fact(n)/fact(per)**BigInt(m),power(m,n));}
export function exactOccupancyOneDouble(input){const {n,m}=balls(input);return rational(n<2||n>m+1?0n:choose(n,2)*falling(m,n-1),power(m,n));}
export function exactOccupancyMaxTwo(input){const {n,m}=balls(input);let d=new Map([['0,0',1n]]);for(let i=0;i<n;i++){const next=new Map();for(const [key,count] of d){const [singles,doubles]=key.split(',').map(Number);const empty=m-singles-doubles;if(empty){const target=`${singles+1},${doubles}`;next.set(target,(next.get(target)||0n)+count*BigInt(empty));}if(singles){const target=`${singles-1},${doubles+1}`;next.set(target,(next.get(target)||0n)+count*BigInt(singles));}}d=next;}return rational([...d.values()].reduce((a,b)=>a+b,0n),power(m,n));}
export const EXACT_FINITE_PROBABILITY=Object.freeze([
 ['COIN_EXACT_HEADS','Exact binomial event: k heads in n fair flips',exactCoinExactlyKHeads,{n:6,k:3}],
 ['COIN_AT_MOST_HEADS','Exact fair-coin binomial lower tail',exactCoinAtMostKHeads,{n:6,k:3}],
 ['COIN_AT_LEAST_HEADS','Exact fair-coin binomial upper tail',exactCoinAtLeastKHeads,{n:6,k:3}],
 ['COIN_EXACT_RUNS','Exact count of consecutive constant-bit runs',exactCoinExactlyKRuns,{n:6,k:3}],
 ['COIN_FIRST_HEAD','First head on specified flip',exactCoinFirstHeadAtK,{n:6,k:3}],
 ['COIN_LAST_HEAD','Last head on specified flip',exactCoinLastHeadAtK,{n:6,k:3}],
 ['COIN_MAX_ONES_RUN','Longest consecutive one-bit run at most k',exactCoinMaxOnesRun,{n:6,k:3}],
 ['COIN_ADJACENT_ONES','Exactly k adjacent 11 pairs in fair flips',exactCoinExactlyKAdjacentOnes,{n:6,k:3}],
 ['COIN_ZERO_ONE_TRANSITIONS','Exactly k 01 transitions in fair flips',exactCoinExactlyKZeroOneTransitions,{n:6,k:3}],
 ['COIN_NONADJACENT_K_HEADS','Exactly k heads without adjacent heads',exactCoinNoAdjacentKHeads,{n:6,k:3}],
 ['WALK_ENDPOINT','Symmetric simple random-walk final displacement equals k',exactWalkFinalDisplacement,{n:6,k:2}],
 ['WALK_MAX_BOUND','Symmetric simple random walk never above k',exactWalkMaximumAtMostK,{n:6,k:2}],
 ['WALK_FIRST_RETURN','First return to zero on step n of symmetric simple walk',exactWalkFirstReturnAtN,{n:6,k:0}],
 ['OCCUPANCY_NO_COLLISIONS','All labeled balls occupy distinct equally likely bins',exactOccupancyNoCollisions,{n:5,m:4}],
 ['OCCUPANCY_COLLISION','At least one repeated bin for independent labeled balls',exactOccupancyAtLeastOneCollision,{n:5,m:4}],
 ['OCCUPANCY_ALL_BINS','All bins observed in n independent uniform draws',exactOccupancyAllBinsSeen,{n:5,m:4}],
 ['OCCUPANCY_K_NONEMPTY','Exactly k nonempty bins in uniform occupancy',exactOccupancyExactlyKNonempty,{n:5,m:4,k:3}],
 ['OCCUPANCY_BIN_EMPTY','Particular bin receives zero draws',exactOccupancyFixedBinEmpty,{n:5,m:4}],
 ['OCCUPANCY_BIN_EXACT','Particular bin receives exactly k draws',exactOccupancyFixedBinExactlyK,{n:5,m:4,k:3}],
 ['OCCUPANCY_BIN_TAIL','Particular bin receives at least k draws',exactOccupancyFixedBinAtLeastK,{n:5,m:4,k:3}],
 ['OCCUPANCY_EQUAL','Every bin receives exactly the same count',exactOccupancyEqualBins,{n:4,m:2}],
 ['OCCUPANCY_ONE_DOUBLE','Exactly one bin has two draws and all other occupied bins have one',exactOccupancyOneDouble,{n:5,m:4}],
 ['OCCUPANCY_MAX_TWO','No occupancy exceeds two labeled balls',exactOccupancyMaxTwo,{n:5,m:4}],
].map(([code,description,execute,input],index)=>Object.freeze({id:`GAUSS.STATS.${code}.${String(201+index).padStart(3,'0')}`,domain:'STATISTICS_PROBABILITY',description,execute,input:Object.freeze(input)})));
