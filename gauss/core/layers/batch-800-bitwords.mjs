import {record,integer,output,entries,range,rational} from './batch-800-common.mjs';
const parse=x=>{record(x,['width','value']);const w=integer(x.width,'width',1,32),v=integer(x.value,'value',0,2**w-1);return {w,v:BigInt(v),mask:(1n<<BigInt(w))-1n};};
const bits=({w,v})=>range(w).map(i=>Number(v>>BigInt(i)&1n));
const pc=v=>{let c=0;while(v){v&=v-1n;c++;}return c;};
const positions=t=>bits(t).flatMap((v,i)=>v?[i]:[]);
const shifted=(t,k)=>BigInt(k)%BigInt(t.w);
const pair=x=>{record(x,['width','left','right']);const a=parse({width:x.width,value:x.left}),b=parse({width:x.width,value:x.right});return [a,b];};
const withK=x=>{record(x,['width','value','k']);const t=parse({width:x.width,value:x.value});return [t,integer(x.k,'k',0,t.w)];};
function runs(a,v){let best=0,cur=0;for(const bit of a){cur=bit===v?cur+1:0;best=Math.max(best,cur);}return best;}
export function bitPopcount(x){return output({count:pc(parse(x).v)});}
export function bitParity(x){return output({parity:pc(parse(x).v)%2});}
export function bitLeadingZeros(x){const t=parse(x);return output({count:runs(bits(t).reverse(),0)===t.w?t.w:bits(t).reverse().findIndex(v=>v===1)});}
export function bitTrailingZeros(x){const t=parse(x);return output({count:bits(t).findIndex(v=>v===1)<0?t.w:bits(t).findIndex(v=>v===1)});}
export function bitMostSignificant(x){const t=parse(x);return output({index:t.v?bits(t).lastIndexOf(1):null});}
export function bitLeastSignificant(x){const t=parse(x);return output({index:t.v?bits(t).indexOf(1):null});}
export function bitReverse(x){const t=parse(x);return output({value:Number(bits(t).reduce((s,b,i)=>s|BigInt(b)<<BigInt(t.w-1-i),0n))});}
export function bitComplement(x){const t=parse(x);return output({value:Number(t.v^t.mask)});}
export function bitRotateLeft(x){const [t,k]=withK(x),s=shifted(t,k);return output({value:Number(((t.v<<s)|(t.v>>(BigInt(t.w)-s)))&t.mask)});}
export function bitRotateRight(x){const [t,k]=withK(x),s=shifted(t,k);return output({value:Number(((t.v>>s)|(t.v<<(BigInt(t.w)-s)))&t.mask)});}
export function bitGrayEncode(x){const t=parse(x);return output({value:Number(t.v^(t.v>>1n))});}
export function bitGrayDecode(x){const t=parse(x);let v=t.v;for(let s=1n;s<BigInt(t.w);s*=2n)v^=v>>s;return output({value:Number(v&t.mask)});}
export function bitOnePositions(x){return output({positions:positions(parse(x))});}
export function bitZeroPositions(x){const t=parse(x);return output({positions:range(t.w).filter(i=>!(t.v>>BigInt(i)&1n))});}
export function bitLongestOneRun(x){return output({length:runs(bits(parse(x)),1)});}
export function bitLongestZeroRun(x){return output({length:runs(bits(parse(x)),0)});}
export function bitLinearTransitions(x){const a=bits(parse(x));return output({count:a.slice(1).filter((v,i)=>v!==a[i]).length});}
export function bitCircularTransitions(x){const a=bits(parse(x));return output({count:a.filter((v,i)=>v!==a[(i+1)%a.length]).length});}
export function bitHammingDistance(x){const [a,b]=pair(x);return output({distance:pc(a.v^b.v)});}
export function bitIntersectionSize(x){const [a,b]=pair(x);return output({count:pc(a.v&b.v)});}
export function bitUnionSize(x){const [a,b]=pair(x);return output({count:pc(a.v|b.v)});}
export function bitJaccard(x){const [a,b]=pair(x);return output({similarity:rational(BigInt(pc(a.v&b.v)),BigInt(pc(a.v|b.v)||1))});}
export function bitRank(x){const [t,k]=withK(x);return output({rank:pc(t.v&((1n<<BigInt(k))-1n))});}
export function bitSelect(x){const [t,k]=withK(x),p=positions(t);return output({position:p[k]??null});}
export function bitPrefixXors(x){const t=parse(x),a=bits(t);let p=0;return output({parities:a.map(v=>{p^=v;return p;})});}
const s={width:8,value:178},by={width:8,value:178,k:3},tw={width:8,left:178,right:204};
const specs=[['BIT_POPCOUNT','Exact number of set bits',bitPopcount,s],['BIT_PARITY','Parity of a bounded bitword',bitParity,s],['BIT_LEADING_ZEROS','Number of leading zero bits',bitLeadingZeros,s],['BIT_TRAILING_ZEROS','Number of trailing zero bits',bitTrailingZeros,s],['BIT_MSB','Most significant set-bit index',bitMostSignificant,s],['BIT_LSB','Least significant set-bit index',bitLeastSignificant,s],['BIT_REVERSE','Reverse order of all fixed-width bits',bitReverse,s],['BIT_COMPLEMENT','Fixed-width ones complement',bitComplement,s],['BIT_ROTL','Fixed-width circular left rotation',bitRotateLeft,by],['BIT_ROTR','Fixed-width circular right rotation',bitRotateRight,by],['BIT_GRAY_ENCODE','Binary reflected Gray code encoding',bitGrayEncode,s],['BIT_GRAY_DECODE','Inverse binary reflected Gray code transformation',bitGrayDecode,s],['BIT_ONE_POSITIONS','Ascending indices of set bits',bitOnePositions,s],['BIT_ZERO_POSITIONS','Ascending indices of clear bits',bitZeroPositions,s],['BIT_LONGEST_ONE_RUN','Longest contiguous run of one bits',bitLongestOneRun,s],['BIT_LONGEST_ZERO_RUN','Longest contiguous run of zero bits',bitLongestZeroRun,s],['BIT_LINEAR_TRANSITIONS','Number of adjacent bit transitions',bitLinearTransitions,s],['BIT_CIRCULAR_TRANSITIONS','Number of cyclic bit transitions',bitCircularTransitions,s],['BIT_HAMMING_DISTANCE','Hamming distance of two equal-width bitwords',bitHammingDistance,tw],['BIT_INTERSECTION_SIZE','Intersection cardinality of bitmask sets',bitIntersectionSize,tw],['BIT_UNION_SIZE','Union cardinality of bitmask sets',bitUnionSize,tw],['BIT_JACCARD','Exact rational bitset Jaccard coefficient',bitJaccard,tw],['BIT_RANK','Number of set bits in the lowest k bit positions',bitRank,by],['BIT_SELECT','Zero-indexed select of kth set bit or null',bitSelect,by],['BIT_PREFIX_PARITIES','Parity of every least-significant-bit prefix',bitPrefixXors,s]];
export const BITWORDS_800=entries(specs,'INFO','INFORMATION_THEORY',726);
