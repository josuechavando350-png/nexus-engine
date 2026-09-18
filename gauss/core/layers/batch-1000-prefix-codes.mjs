// Binary codebooks: exact Kraft/length arithmetic and bounded information measures.
import {object,arr,int,freeze,entries,q,qa,qs,qm,qd,qstr,zero,one} from './batch-1000-common.mjs';
const Z=zero(),O=one();
const sample={symbols:['a','b','c','d'],codewords:['0','10','110','111']};
function book(x){object(x,['symbols','codewords']);const syms=arr(x.symbols,'symbols',1,12),words=arr(x.codewords,'codewords',syms.length,syms.length);syms.forEach((s,i)=>{if(typeof s!=='string'||[...s].length!==1||s.length>2)throw new TypeError(`symbol ${i} must be one Unicode code point`);});words.forEach((w,i)=>{if(typeof w!=='string'||!/^[01]{1,12}$/.test(w))throw new TypeError(`codeword ${i} must be 1-12 bits`);});if(new Set(syms).size!==syms.length||new Set(words).size!==words.length)throw new TypeError('symbols and codewords must be unique');return {syms,words};}
const prefix=words=>words.every((w,i)=>words.every((v,j)=>i===j||!v.startsWith(w)));
const suffix=words=>words.every((w,i)=>words.every((v,j)=>i===j||!v.endsWith(w)));
const kraft=words=>words.reduce((s,w)=>qa(s,qd(O,q((2n**BigInt(w.length)).toString()))),Z);
const values=x=>{object(x,['symbols','codewords','frequencies']);const b=book({symbols:x.symbols,codewords:x.codewords}),freq=arr(x.frequencies,'frequencies',b.syms.length,b.syms.length).map(v=>int(v,'frequency',0,1000000));if(freq.every(v=>v===0))throw new TypeError('positive frequency mass required');return {...b,freq};};
const mean=({words,freq})=>qd(q(words.reduce((s,w,i)=>s+w.length*freq[i],0)),q(freq.reduce((s,v)=>s+v,0)));
function trie(words){const root={end:false,children:[null,null]};for(const word of words){let node=root;for(const ch of word){const c=+ch;node.children[c]??={end:false,children:[null,null]};node=node.children[c];}node.end=true;}return root;}
function nodes(t){return [t,...t.children.filter(Boolean).flatMap(nodes)];}
export function codePrefixFree(x){return freeze({prefixFree:prefix(book(x).words)});}
export function codeSuffixFree(x){return freeze({suffixFree:suffix(book(x).words)});}
export function codeUniquelyDecodable(x){const words=book(x).words;let current=new Set();for(let i=0;i<words.length;i++)for(let j=0;j<words.length;j++)if(i!==j&&words[j].startsWith(words[i]))current.add(words[j].slice(words[i].length));const seen=new Set();while(current.size){const next=new Set();for(const s of current){if(!s||words.includes(s))return freeze({uniquelyDecodable:false});if(seen.has(s))continue;seen.add(s);for(const w of words){if(s.startsWith(w))next.add(s.slice(w.length));if(w.startsWith(s))next.add(w.slice(s.length));}}current=next;}return freeze({uniquelyDecodable:true});}
export function codeKraftSum(x){return freeze({sum:qstr(kraft(book(x).words))});}
export function codeKraftSlack(x){return freeze({slack:qstr(qs(O,kraft(book(x).words)))});}
export function codeMaximumLength(x){return freeze({length:Math.max(...book(x).words.map(w=>w.length))});}
export function codeMinimumLength(x){return freeze({length:Math.min(...book(x).words.map(w=>w.length))});}
export function codeLengthHistogram(x){const w=book(x).words,counts=Array(Math.max(...w.map(v=>v.length))+1).fill(0);for(const c of w)counts[c.length]++;return freeze({counts});}
export function codeAverageLength(x){return freeze({average:qstr(mean(values(x)))});}
export function codeLengthVariance(x){const v=values(x),m=mean(v),s=q(v.freq.reduce((a,b)=>a+b,0));return freeze({variance:qstr(qd(v.words.reduce((a,w,i)=>qa(a,qm(q(v.freq[i]),qm(qs(q(w.length),m),qs(q(w.length),m)))),Z),s))});}
export function codeSourceEntropy(x){const v=values(x),s=v.freq.reduce((a,b)=>a+b,0);return freeze({bits:v.freq.reduce((a,k)=>k?a-(k/s)*Math.log2(k/s):a,0)});}
export function codeRedundancy(x){const v=values(x),s=v.freq.reduce((a,b)=>a+b,0),entropy=v.freq.reduce((a,k)=>k?a-(k/s)*Math.log2(k/s):a,0),m=mean(v);return freeze({bits:Number(m.n)/Number(m.d)-entropy});}
export function codeEncode(x){object(x,['symbols','codewords','message']);const b=book({symbols:x.symbols,codewords:x.codewords});if(typeof x.message!=='string'||[...x.message].length>128)throw new TypeError('bounded string message required');const map=new Map(b.syms.map((s,i)=>[s,b.words[i]]));let bits='';for(const s of x.message){if(!map.has(s))throw new TypeError('unknown symbol');bits+=map.get(s);}return freeze({bits});}
export function codeDecode(x){object(x,['symbols','codewords','bits']);const b=book({symbols:x.symbols,codewords:x.codewords});if(!prefix(b.words))throw new TypeError('instantaneous prefix code required');if(typeof x.bits!=='string'||x.bits.length>1536||!/^[01]*$/.test(x.bits))throw new TypeError('bounded binary message required');const map=new Map(b.words.map((w,i)=>[w,b.syms[i]]));let buf='',message='';for(const bit of x.bits){buf+=bit;if(map.has(buf)){message+=map.get(buf);buf='';}else if(!b.words.some(w=>w.startsWith(buf)))throw new TypeError('unrecognized bit sequence');}if(buf)throw new TypeError('incomplete terminal codeword');return freeze({message});}
export function codeTrieNodeCount(x){return freeze({count:nodes(trie(book(x).words)).length});}
export function codeTrieLeafCount(x){return freeze({count:nodes(trie(book(x).words)).filter(n=>n.children.every(c=>c===null)).length});}
export function codeTrieInternalCount(x){return freeze({count:nodes(trie(book(x).words)).filter(n=>n.children.some(Boolean)).length});}
export function codeTrieMaximumDepth(x){const w=book(x).words;return freeze({depth:Math.max(...w.map(v=>v.length))});}
export function codeComplete(x){const w=book(x).words;return freeze({complete:prefix(w)&&qs(kraft(w),O).n===0n});}
export function codeHammingDistance(x){const w=book(x).words;let best=Infinity;for(let i=0;i<w.length;i++)for(let j=i+1;j<w.length;j++)if(w[i].length===w[j].length){const d=[...w[i]].filter((v,k)=>v!==w[j][k]).length;best=Math.min(best,d);}return freeze({minimum:best===Infinity?null:best});}
export function codeLexicographicOrder(x){return freeze({codewords:book(x).words.slice().sort()});}
export function codeReverseBits(x){const b=book(x);return freeze({codewords:b.words.map(w=>[...w].reverse().join(''))});}
export function codeComplementBits(x){const b=book(x);return freeze({codewords:b.words.map(w=>[...w].map(ch=>ch==='0'?'1':'0').join(''))});}
export function codeCanonicalFromLengths(x){object(x,['symbols','lengths']);const syms=arr(x.symbols,'symbols',1,12);if(new Set(syms).size!==syms.length||syms.some(s=>typeof s!=='string'||[...s].length!==1||s.length>2))throw new TypeError('unique code point symbols required');const lengths=arr(x.lengths,'lengths',syms.length,syms.length).map(v=>int(v,'length',1,12)),order=syms.map((s,i)=>({s,i,l:lengths[i]})).sort((a,b)=>a.l-b.l||a.i-b.i),out=Array(syms.length);let code=0,len=order[0].l;for(const item of order){code*=2**(item.l-len);len=item.l;if(code>=2**len)throw new RangeError('Kraft bound exceeded');out[item.i]=code.toString(2).padStart(len,'0');code++;}return freeze({codewords:out});}
export function codeAvailableAtLength(x){object(x,['symbols','codewords','length']);const b=book({symbols:x.symbols,codewords:x.codewords}),len=int(x.length,'length',1,12);if(!prefix(b.words))throw new TypeError('prefix-free input required');let free=0;for(let i=0;i<2**len;i++){const w=i.toString(2).padStart(len,'0');if(b.words.every(bw=>!bw.startsWith(w)&&!w.startsWith(bw)))free++;}return freeze({available:free});}
const V={...sample,frequencies:[8,4,2,2]};
const specs=[
 ['PREFIX_FREE','Instantaneous prefix-free property of a codebook',codePrefixFree,sample],
 ['SUFFIX_FREE','Suffix-free property of binary codewords',codeSuffixFree,sample],
 ['UNIQUELY_DECODABLE','Sardinas-Patterson unique decodability of binary code',codeUniquelyDecodable,sample],
 ['KRAFT_SUM','Exact rational Kraft sum of binary codeword lengths',codeKraftSum,sample],
 ['KRAFT_SLACK','Exact Kraft capacity remaining to a complete binary code',codeKraftSlack,sample],
 ['MAX_LENGTH','Maximum binary codeword length',codeMaximumLength,sample],
 ['MIN_LENGTH','Minimum binary codeword length',codeMinimumLength,sample],
 ['LENGTH_HISTOGRAM','Histogram of codeword lengths',codeLengthHistogram,sample],
 ['WEIGHTED_AVERAGE','Exact weighted average coding length',codeAverageLength,V],
 ['LENGTH_VARIANCE','Exact weighted codeword-length variance',codeLengthVariance,V],
 ['SOURCE_ENTROPY','Approximate Shannon entropy of supplied frequencies in bits',codeSourceEntropy,V],
 ['REDUNDANCY','Approximate expected-length redundancy over entropy',codeRedundancy,V],
 ['ENCODE','Encode a bounded Unicode message using supplied codebook',codeEncode,{...sample,message:'abdcab'}],
 ['DECODE','Decode a prefix-free binary message into Unicode symbols',codeDecode,{...sample,bits:'0101111100'}],
 ['TRIE_NODES','Count nodes of the binary codeword prefix trie',codeTrieNodeCount,sample],
 ['TRIE_LEAVES','Count leaves of the binary codeword prefix trie',codeTrieLeafCount,sample],
 ['TRIE_INTERNAL','Count internal branching-or-single-child trie nodes',codeTrieInternalCount,sample],
 ['TRIE_DEPTH','Maximum depth of codeword prefix trie',codeTrieMaximumDepth,sample],
 ['COMPLETE','Prefix-free codebook with Kraft equality',codeComplete,sample],
 ['HAMMING_MIN','Minimum pairwise distance among equal-length binary codewords',codeHammingDistance,sample],
 ['LEX_ORDER','Lexicographic ordering of binary codewords',codeLexicographicOrder,sample],
 ['REVERSE','Reverse every codeword bit sequence',codeReverseBits,sample],
 ['COMPLEMENT','Complement every codeword bit sequence',codeComplementBits,sample],
 ['CANONICAL','Generate canonical prefix code from admissible word lengths',codeCanonicalFromLengths,{symbols:sample.symbols,lengths:[1,2,3,3]}],
 ['AVAILABLE_LENGTH','Count unused valid codewords of a proposed fixed length',codeAvailableAtLength,{...sample,length:4}],
];
export const PREFIX_CODES_1000=entries(specs,'INFO.PREFIX_CODES','INFORMATION_THEORY',976);
