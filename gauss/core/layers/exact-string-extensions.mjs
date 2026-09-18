// Deterministic Unicode scalar algorithms; all positions use Unicode code points.
import {unicodeAdjacentLcp} from './exact-string-algorithms.mjs';
const LIMIT=1024;
function scalar(s,name='text'){
 if(typeof s!=='string'||s.length>LIMIT*2)throw new TypeError(`${name} must be bounded Unicode string`);
 const a=[];for(const c of s){let p=c.codePointAt(0);if(p>=0xD800&&p<=0xDFFF)throw new TypeError('unpaired surrogate');a.push(p);if(a.length>LIMIT)throw new RangeError(`${name} is too long`);}return a;
}
function fields(input,names){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==names.length||names.some(k=>!Object.hasOwn(input,k)))throw new TypeError(`expected ${names.join(',')}`);return names.map(k=>scalar(input[k],k));}
const freeze = object=>Object.freeze(object);
function prefix(a){let pi=Array(a.length).fill(0);for(let i=1;i<a.length;i++){let j=pi[i-1];while(j&&a[i]!==a[j])j=pi[j-1];if(a[i]===a[j])j++;pi[i]=j;}return pi;}
function zvalues(a){const z=Array(a.length).fill(0);for(let i=1,l=0,r=0;i<a.length;i++){if(i<=r)z[i]=Math.min(r-i+1,z[i-l]);while(i+z[i]<a.length&&a[z[i]]===a[i+z[i]])z[i]++;if(i+z[i]-1>r){l=i;r=i+z[i]-1;}}if(a.length)z[0]=a.length;return z;}
function period(a){let n=a.length;if(!n)return 0;let p=n-prefix(a).at(-1);return n%p===0?p:n;}
function manacher(a){const n=a.length,odd=Array(n).fill(0),even=Array(n).fill(0);for(let i=0,l=0,r=-1;i<n;i++){let k=i>r?1:Math.min(odd[l+r-i],r-i+1);while(i-k>=0&&i+k<n&&a[i-k]===a[i+k])k++;odd[i]=k--;if(i+k>r){l=i-k;r=i+k;}}for(let i=0,l=0,r=-1;i<n;i++){let k=i>r?0:Math.min(even[l+r-i+1],r-i+1);while(i-k-1>=0&&i+k<n&&a[i-k-1]===a[i+k])k++;even[i]=k--;if(i+k>r){l=i-k-1;r=i+k;}}return {odd,even};}
function palindrome(a,start=0,end=a.length){for(let i=start,j=end-1;i<j;i++,j--)if(a[i]!==a[j])return false;return true;}
function text(points){return String.fromCodePoint(...points);}
function rotation(a){const n=a.length;if(!n)return 0;const s=a.concat(a);let i=0,j=1,k=0;while(i<n&&j<n&&k<n){const x=s[i+k],y=s[j+k];if(x===y){k++;continue;}if(x>y){i+=k+1;if(i<=j)i=j+1;}else{j+=k+1;if(j<=i)j=i+1;}k=0;}return Math.min(i,j);}
export function exactUnicodePrefixFunction(input){const [a]=fields(input,['text']);return freeze({prefix:freeze(prefix(a))});}
export function exactUnicodeZFunction(input){const [a]=fields(input,['text']);return freeze({z:freeze(zvalues(a))});}
export function exactUnicodeMinimalPeriod(input){const [a]=fields(input,['text']);return freeze({length:period(a)});}
export function exactUnicodeBorders(input){const [a]=fields(input,['text']);const pi=prefix(a),result=[];for(let k=pi.at(-1)||0;k;k=pi[k-1])result.push(k);return freeze({lengths:freeze(result.reverse())});}
export function exactUnicodeLongestBorder(input){const [a]=fields(input,['text']);return freeze({length:prefix(a).at(-1)||0});}
export function exactUnicodeLongestPalindrome(input){const [a]=fields(input,['text']);const {odd,even}=manacher(a);let start=0,length=0;for(let i=0;i<a.length;i++)for(const [size,begin] of [[2*odd[i]-1,i-odd[i]+1],[2*even[i],i-even[i]]])if(size>length){length=size;start=begin;}return freeze({start,length,substring:text(a.slice(start,start+length))});}
export function exactUnicodePalindromeCount(input){const [a]=fields(input,['text']);const {odd,even}=manacher(a);return freeze({count:String(odd.reduce((s,x)=>s+BigInt(x),0n)+even.reduce((s,x)=>s+BigInt(x),0n))});}
export function exactUnicodeDistinctPalindromes(input){
 const [a]=fields(input,['text']);
 // Palindromic tree (Eertree): one node per distinct palindrome, O(n) transitions.
 const nodes=[{length:-1,link:0,next:new Map()},{length:0,link:0,next:new Map()}];
 let last=1;
 for(let i=0;i<a.length;i++){
  let current=last;
  while(a[i-1-nodes[current].length]!==a[i])current=nodes[current].link;
  const existing=nodes[current].next.get(a[i]);
  if(existing!==undefined){last=existing;continue;}
  const length=nodes[current].length+2;
  const created=nodes.length;
  nodes.push({length,link:0,next:new Map()});
  nodes[current].next.set(a[i],created);
  if(length===1)nodes[created].link=1;
  else{
   let suffix=nodes[current].link;
   while(a[i-1-nodes[suffix].length]!==a[i])suffix=nodes[suffix].link;
   nodes[created].link=nodes[suffix].next.get(a[i]);
  }
  last=created;
 }
 return freeze({count:nodes.length-2});
}
export function exactUnicodePalindromicSubsequence(input){const [a]=fields(input,['text']);const n=a.length,d=Array.from({length:n},()=>Array(n).fill(0));for(let i=n-1;i>=0;i--)for(let j=i;j<n;j++)d[i][j]=i===j?1:a[i]===a[j]?2+(i+1<j?d[i+1][j-1]:0):Math.max(d[i+1][j],d[i][j-1]);return freeze({length:n?d[0][n-1]:0});}
export function exactUnicodePalindromeAppend(input){const [a]=fields(input,['text']);let s=0;while(s<a.length&&!palindrome(a,s))s++;const addition=a.slice(0,s).reverse();return freeze({added:addition.length,text:text(a.concat(addition))});}
export function exactUnicodePalindromePrepend(input){const [a]=fields(input,['text']);let e=a.length;while(e>0&&!palindrome(a,0,e))e--;const addition=a.slice(e).reverse();return freeze({added:addition.length,text:text(addition.concat(a))});}
export function exactUnicodeMinimumRotation(input){const [a]=fields(input,['text']);const start=rotation(a);return freeze({start,rotation:text(a.slice(start).concat(a.slice(0,start)))});}
export function exactUnicodeRotationClasses(input){const [a]=fields(input,['text']);return freeze({count:period(a)});}
export function exactUnicodeLyndonFactors(input){const [a]=fields(input,['text']);const factors=[];let i=0;while(i<a.length){let j=i+1,k=i;while(j<a.length&&a[k]<=a[j]){if(a[k]<a[j])k=i;else k++;j++;}const width=j-k;while(i<=k){factors.push(text(a.slice(i,i+width)));i+=width;}}return freeze({factors:freeze(factors)});}
export function exactUnicodeLongestUniqueSpan(input){const [a]=fields(input,['text']);let bestStart=0,bestLength=0,start=0;const last=new Map();for(let i=0;i<a.length;i++){const prev=last.get(a[i]);if(prev!==undefined&&prev>=start)start=prev+1;last.set(a[i],i);if(i-start+1>bestLength){bestLength=i-start+1;bestStart=start;}}return freeze({start:bestStart,length:bestLength});}
export function exactUnicodeInversions(input){const [a]=fields(input,['text']);function solve(xs){if(xs.length<2)return [xs,0n];const m=xs.length>>1,[l,a]=solve(xs.slice(0,m)),[r,b]=solve(xs.slice(m));let i=0,j=0,c=a+b;const s=[];while(i<l.length&&j<r.length)if(l[i]<=r[j])s.push(l[i++]);else{c+=BigInt(l.length-i);s.push(r[j++]);}return [s.concat(l.slice(i),r.slice(j)),c];}return freeze({count:solve(a)[1].toString()});}
export function exactUnicodeDistinctSubstringCount(input){const [a]=fields(input,['text']);const {lcp}=unicodeAdjacentLcp({text:input.text});const n=BigInt(a.length);return freeze({count:(n*(n+1n)/2n-lcp.reduce((s,x)=>s+BigInt(x),0n)).toString()});}
export function exactUnicodeLongestRepeat(input){const [a]=fields(input,['text']);const {indices,lcp}=unicodeAdjacentLcp({text:input.text});let best=0,at=0;for(let i=1;i<lcp.length;i++)if(lcp[i]>best){best=lcp[i];at=indices[i];}return freeze({length:best,substring:text(a.slice(at,at+best))});}
export function exactUnicodeLongestCommonSubstring(input){const [a,b]=fields(input,['left','right']);let d=Array(b.length+1).fill(0),best=0,end=0;for(let i=1;i<=a.length;i++){const next=Array(b.length+1).fill(0);for(let j=1;j<=b.length;j++)if(a[i-1]===b[j-1]){next[j]=d[j-1]+1;if(next[j]>best){best=next[j];end=i;}}d=next;}return freeze({length:best,substring:text(a.slice(end-best,end))});}
export function exactUnicodeSubsequenceOccurrences(input){const [a,b]=fields(input,['text','pattern']);let d=Array(b.length+1).fill(0n);d[0]=1n;for(const x of a)for(let j=b.length;j>=1;j--)if(x===b[j-1])d[j]+=d[j-1];return freeze({count:d[b.length].toString()});}
export function exactUnicodeDistinctSubsequences(input){const [a]=fields(input,['text']);let total=1n;const seen=new Map();for(const x of a){const previous=seen.get(x)||0n;seen.set(x,total);total=total*2n-previous;}return freeze({count:(total-1n).toString()});}
export function exactUnicodeOptimalAlignmentDistance(input){const [a,b]=fields(input,['left','right']);let d=Array.from({length:a.length+1},(_,i)=>Array.from({length:b.length+1},(_,j)=>i+j));for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+Number(a[i-1]!==b[j-1]));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);}return freeze({distance:d[a.length][b.length]});}
export function exactUnicodeHammingDistance(input){const [a,b]=fields(input,['left','right']);if(a.length!==b.length)throw new RangeError('Hamming inputs require equal code-point lengths');return freeze({distance:a.reduce((s,x,i)=>s+Number(x!==b[i]),0)});}
export function exactUnicodeLongestCommonPrefix(input){const [a,b]=fields(input,['left','right']);let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;return freeze({length:i});}
export function exactUnicodeLongestCommonSuffix(input){const [a,b]=fields(input,['left','right']);let i=0;while(i<a.length&&i<b.length&&a[a.length-i-1]===b[b.length-i-1])i++;return freeze({length:i});}
export const EXACT_STRING_EXTENSIONS=Object.freeze([
 ['PREFIX_FUNCTION','Knuth-Morris-Pratt prefix failure array',exactUnicodePrefixFunction,{text:'ababa'}],
 ['Z_FUNCTION','Z algorithm longest prefix match at every offset',exactUnicodeZFunction,{text:'ababa'}],
 ['MINIMUM_PERIOD','Length of shortest repeating block',exactUnicodeMinimalPeriod,{text:'ababab'}],
 ['BORDER_LENGTHS','All proper prefix-suffix border lengths',exactUnicodeBorders,{text:'ababa'}],
 ['LONGEST_BORDER','Maximum length proper prefix also suffix',exactUnicodeLongestBorder,{text:'ababa'}],
 ['LONGEST_PALINDROME','Longest contiguous palindrome by Manacher radii',exactUnicodeLongestPalindrome,{text:'abacaba'}],
 ['PALINDROME_SUBSTRING_COUNT','Count of all palindromic substring occurrences',exactUnicodePalindromeCount,{text:'abacaba'}],
 ['DISTINCT_PALINDROMES','Number of distinct palindromic substrings',exactUnicodeDistinctPalindromes,{text:'abacaba'}],
 ['PALINDROMIC_SUBSEQUENCE_LENGTH','Maximum palindromic subsequence length by DP',exactUnicodePalindromicSubsequence,{text:'character'}],
 ['PALINDROME_APPEND','Minimum suffix append to make a palindrome',exactUnicodePalindromeAppend,{text:'abac'}],
 ['PALINDROME_PREPEND','Minimum prefix prepend to make a palindrome',exactUnicodePalindromePrepend,{text:'abac'}],
 ['MINIMUM_ROTATION','Lexicographically least cyclic rotation by Booth algorithm',exactUnicodeMinimumRotation,{text:'baca'}],
 ['DISTINCT_ROTATIONS','Count of distinct cyclic rotations',exactUnicodeRotationClasses,{text:'ababab'}],
 ['LYNDON_FACTORIZATION','Nonincreasing Chen-Fox-Lyndon factorization by Duval algorithm',exactUnicodeLyndonFactors,{text:'banana'}],
 ['LONGEST_UNIQUE_SPAN','Longest contiguous substring with distinct code points',exactUnicodeLongestUniqueSpan,{text:'abacaba'}],
 ['CODEPOINT_INVERSIONS','Exact inversion count of Unicode code-point array',exactUnicodeInversions,{text:'cba'}],
 ['DISTINCT_SUBSTRINGS','Exact count of distinct nonempty substrings via suffix-array LCP',exactUnicodeDistinctSubstringCount,{text:'banana'}],
 ['LONGEST_REPEATED_SUBSTRING','Maximum repeated contiguous substring by adjacent suffix LCP',exactUnicodeLongestRepeat,{text:'banana'}],
 ['LONGEST_COMMON_SUBSTRING','Longest common contiguous substring of two strings',exactUnicodeLongestCommonSubstring,{left:'banana',right:'ananas'}],
 ['SUBSEQUENCE_OCCURRENCES','Number of embeddings of a pattern as subsequence',exactUnicodeSubsequenceOccurrences,{text:'banana',pattern:'ana'}],
 ['DISTINCT_SUBSEQUENCES','Exact count of distinct nonempty subsequences',exactUnicodeDistinctSubsequences,{text:'banana'}],
 ['OSA_EDIT_DISTANCE','Optimal string alignment edit distance with adjacent transpositions',exactUnicodeOptimalAlignmentDistance,{left:'ca',right:'ac'}],
 ['HAMMING_DISTANCE','Mismatch count on equal-length Unicode strings',exactUnicodeHammingDistance,{left:'abc',right:'adc'}],
 ['COMMON_PREFIX_LENGTH','Longest common Unicode prefix length',exactUnicodeLongestCommonPrefix,{left:'banana',right:'band'}],
 ['COMMON_SUFFIX_LENGTH','Longest common Unicode suffix length',exactUnicodeLongestCommonSuffix,{left:'banana',right:'ananas'}],
].map(([code,description,execute,input],index)=>Object.freeze({id:`GAUSS.CS.${code}.${String(201+index).padStart(3,'0')}`,domain:'COMPUTER_SCIENCE',description,execute,input:Object.freeze(input)})));
