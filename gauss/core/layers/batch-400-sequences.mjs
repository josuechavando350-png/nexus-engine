import {fields,seq,scalar,int,pack,gcd} from './batch-400-common.mjs';
const S=x=>seq(x);const V=x=>pack({value:String(x)});
const withTarget=x=>{const a=seq(x,['values','target']);return [a,scalar(x.target)];};
const withK=x=>{const a=seq(x,['values','k']);return [a,int(x.k,'k',0,14)];};
const entries=m=>[...m].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([v,c])=>({value:String(v),count:String(c)}));
const combos=(a,cb)=>{const n=a.length;for(let mask=0;mask<(1<<n);mask++){let s=0n,k=0;for(let j=0;j<n;j++)if(mask>>j&1){s+=a[j];k++;}cb(s,k,mask);}};
const ranges=(a,cb)=>{for(let i=0;i<a.length;i++){let sum=0n;for(let j=i;j<a.length;j++){sum+=a[j];cb(sum,i,j);}}};
export function seqSubsetSumCount(x){const[a,t]=withTarget(x);let c=0n;combos(a,s=>{if(s===t)c++;});return V(c);}
export function seqSubsetDistinctSums(x){const a=S(x),s=new Set();combos(a,v=>s.add(v));return V(s.size);}
export function seqSubsetSumHistogram(x){const a=S(x),m=new Map();combos(a,s=>m.set(s,(m.get(s)??0n)+1n));return pack({histogram:entries(m)});}
export function seqSubsetExactKSum(x){fields(x,['values','k','target']);const a=seq({values:x.values}),t=scalar(x.target),k=int(x.k,'k',0,a.length);let c=0n;combos(a,(s,count)=>{if(count===k&&s===t)c++;});return V(c);}
export function seqSubsetXorHistogram(x){const a=S(x);if(a.some(v=>v<0n||v>65535n))throw new RangeError('XOR operands must be unsigned 16-bit integers');const m=new Map();for(let mask=0;mask<(1<<a.length);mask++){let z=0n;for(let j=0;j<a.length;j++)if(mask>>j&1)z^=a[j];m.set(z,(m.get(z)??0n)+1n);}return pack({histogram:entries(m)});}
export function seqPairSumHistogram(x){const a=S(x),m=new Map();for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){const v=a[i]+a[j];m.set(v,(m.get(v)??0n)+1n);}return pack({histogram:entries(m)});}
export function seqPairProductHistogram(x){const a=S(x),m=new Map();for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){const v=a[i]*a[j];m.set(v,(m.get(v)??0n)+1n);}return pack({histogram:entries(m)});}
export function seqSubarraySumCount(x){const[a,t]=withTarget(x);let c=0n;ranges(a,s=>{if(s===t)c++;});return V(c);}
export function seqLongestSubarraySum(x){const[a,t]=withTarget(x);let witness=null;ranges(a,(s,i,j)=>{if(s===t&&(!witness||j-i+1>witness.length)){witness={start:i,end:j,length:j-i+1};}});return pack({witness});}
export function seqAllSubarraySum(x){const a=S(x);let z=0n;ranges(a,s=>{z+=s;});return V(z);}
export function seqAllSubarraySquares(x){const a=S(x);let z=0n;ranges(a,s=>{z+=s*s;});return V(z);}
function extremum(a,compare){let best=null;ranges(a,(s,i,j)=>{if(!best||compare(s,best.value))best={value:s,start:i,end:j};});return pack({witness:best});}
export function seqMaximumSubarray(x){return extremum(S(x),(a,b)=>a>b);}
export function seqMinimumSubarray(x){return extremum(S(x),(a,b)=>a<b);}
export function seqStrictlyIncreasingPairs(x){const a=S(x);let c=0n;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]<a[j])c++;return V(c);}
export function seqNondecreasingPairs(x){const a=S(x);let c=0n;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]<=a[j])c++;return V(c);}
export function seqInversionCount(x){const a=S(x);let c=0n;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]>a[j])c++;return V(c);}
function maxSubseq(x,nonstrict){const a=S(x),n=a.length,dp=Array(n).fill(1),ways=Array(n).fill(1n);for(let i=0;i<n;i++)for(let j=0;j<i;j++)if(nonstrict?a[j]<=a[i]:a[j]<a[i]){if(dp[j]+1>dp[i]){dp[i]=dp[j]+1;ways[i]=ways[j];}else if(dp[j]+1===dp[i])ways[i]+=ways[j];}const length=n?Math.max(...dp):0;return pack({length,count:n?ways.reduce((s,w,i)=>s+(dp[i]===length?w:0n),0n):1n});}
export function seqLongestIncreasingCount(x){return maxSubseq(x,false);}
export function seqLongestNondecreasingCount(x){return maxSubseq(x,true);}
export function seqDistinctSubsequences(x){const a=S(x),seen=new Map();let total=1n;for(const x of a){const next=2n*total-(seen.get(x)??0n);seen.set(x,total);total=next;}return V(total-1n);}
export function seqAlternatingContiguous(x){const a=S(x);let best=a.length?1:0,cur=best,prev=0;for(let i=1;i<a.length;i++){const sign=a[i]>a[i-1]?1:a[i]<a[i-1]?-1:0;cur=sign&&(sign!==prev)?cur+1:sign?2:1;best=Math.max(best,cur);prev=sign;}return pack({length:best});}
export function seqEqualContiguous(x){const a=S(x);let best=a.length?1:0,cur=best;for(let i=1;i<a.length;i++){cur=a[i]===a[i-1]?cur+1:1;best=Math.max(best,cur);}return pack({length:best});}
export function seqSubarraysGcdOne(x){const a=S(x);let c=0n;for(let i=0;i<a.length;i++){let z=0n;for(let j=i;j<a.length;j++){z=gcd(z,a[j]);if(z===1n)c++;}}return V(c);}
export function seqIncreasingSubseqK(x){const[a,k]=withK(x);if(k===0)return V(1n);let dp=Array.from({length:k+1},()=>Array(a.length).fill(0n));for(let i=0;i<a.length;i++)dp[1][i]=1n;for(let len=2;len<=k;len++)for(let i=0;i<a.length;i++)for(let j=0;j<i;j++)if(a[j]<a[i])dp[len][i]+=dp[len-1][j];return V(dp[k].reduce((s,v)=>s+v,0n));}
export function seqLongestPalindromeContiguous(x){const a=S(x);let best={start:0,length:0};for(let i=0;i<a.length;i++)for(let j=i;j<a.length;j++){let ok=true;for(let l=i,r=j;l<r;l++,r--)if(a[l]!==a[r]){ok=false;break;}if(ok&&j-i+1>best.length)best={start:i,length:j-i+1};}return pack(best);}
export function seqPalindromeSubarrayCount(x){const a=S(x);let c=0n;for(let i=0;i<a.length;i++)for(let j=i;j<a.length;j++){let ok=true;for(let l=i,r=j;l<r;l++,r--)if(a[l]!==a[r]){ok=false;break;}if(ok)c++;}return V(c);}
const a={values:[1,2,1,3]};
const definitions=[
 ['SEQ_SUBSET_SUM_COUNT','Count all index-distinct subsets of a given integer sum',seqSubsetSumCount,{...a,target:3}],
 ['SEQ_SUBSET_DISTINCT_SUMS','Number of distinct attainable subset sums',seqSubsetDistinctSums,a],
 ['SEQ_SUBSET_SUM_HIST','Exact multiplicity distribution of integer subset sums',seqSubsetSumHistogram,a],
 ['SEQ_SUBSET_K_SUM','Count k-element index subsets of a target sum',seqSubsetExactKSum,{...a,k:2,target:3}],
 ['SEQ_SUBSET_XOR_HIST','Exact 16-bit subset-XOR distribution',seqSubsetXorHistogram,a],
 ['SEQ_PAIR_SUM_HIST','Exact unordered pair-sum multiplicity distribution',seqPairSumHistogram,a],
 ['SEQ_PAIR_PRODUCT_HIST','Exact unordered pair-product multiplicity distribution',seqPairProductHistogram,a],
 ['SEQ_SUBARRAY_SUM_COUNT','Count contiguous subarrays of an exact target sum',seqSubarraySumCount,{...a,target:3}],
 ['SEQ_LONGEST_SUBARRAY_SUM','Longest contiguous subarray matching exact target sum with witness',seqLongestSubarraySum,{...a,target:3}],
 ['SEQ_ALL_SUBARRAY_SUM','Exact sum of every contiguous subarray sum',seqAllSubarraySum,a],
 ['SEQ_ALL_SUBARRAY_SQUARES','Exact sum of squares of every contiguous subarray sum',seqAllSubarraySquares,a],
 ['SEQ_MAX_SUBARRAY','Exact maximum nonempty contiguous subarray with witness',seqMaximumSubarray,a],
 ['SEQ_MIN_SUBARRAY','Exact minimum nonempty contiguous subarray with witness',seqMinimumSubarray,a],
 ['SEQ_INCREASING_PAIRS','Count index-ordered strictly increasing pairs',seqStrictlyIncreasingPairs,a],
 ['SEQ_NONDECREASING_PAIRS','Count index-ordered nondecreasing pairs',seqNondecreasingPairs,a],
 ['SEQ_INVERSIONS','Exact integer sequence inversion count',seqInversionCount,a],
 ['SEQ_LIS_COUNT','Length and count of longest strictly increasing subsequences',seqLongestIncreasingCount,a],
 ['SEQ_LNDS_COUNT','Length and count of longest nondecreasing subsequences',seqLongestNondecreasingCount,a],
 ['SEQ_DISTINCT_SUBSEQUENCES','Number of distinct nonempty integer value subsequences',seqDistinctSubsequences,a],
 ['SEQ_ALTERNATING_RUN','Longest strictly alternating contiguous comparison run',seqAlternatingContiguous,a],
 ['SEQ_EQUAL_RUN','Longest constant contiguous run',seqEqualContiguous,a],
 ['SEQ_SUBARRAY_GCD_ONE','Count contiguous subarrays whose gcd equals one',seqSubarraysGcdOne,a],
 ['SEQ_INCREASING_K','Count strictly increasing index subsequences of length k',seqIncreasingSubseqK,{...a,k:2}],
 ['SEQ_LONGEST_PAL_RUN','Longest contiguous numeric palindrome with start witness',seqLongestPalindromeContiguous,a],
 ['SEQ_PAL_SUBARRAY_COUNT','Count all contiguous numeric palindromes',seqPalindromeSubarrayCount,a],
];
export const EXACT_SEQUENCES_400=Object.freeze(definitions.map(([code,description,execute,input],i)=>Object.freeze({id:`GAUSS.STATS.${code}.${301+i}`,domain:'STATISTICS_PROBABILITY',description,execute,input:Object.freeze(input)})));
