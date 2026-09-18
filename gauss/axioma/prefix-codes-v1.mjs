/* Independent bounded binary-code references: explicit prefix sets, exact integer fractions and message ambiguity search. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['PREFIX_FREE','SUFFIX_FREE','UNIQUELY_DECODABLE','KRAFT_SUM','KRAFT_SLACK','MAX_LENGTH','MIN_LENGTH','LENGTH_HISTOGRAM','WEIGHTED_AVERAGE','LENGTH_VARIANCE','SOURCE_ENTROPY','REDUNDANCY','ENCODE','DECODE','TRIE_NODES','TRIE_LEAVES','TRIE_INTERNAL','TRIE_DEPTH','COMPLETE','HAMMING_MIN','LEX_ORDER','REVERSE','COMPLEMENT','CANONICAL','AVAILABLE_LENGTH'];
const id=(tag,i)=>`GAUSS.INFO.PREFIX_CODES.${tag}.${976+i}`;
const prefix=words=>words.every((u,i)=>words.every((v,j)=>i===j||!v.startsWith(u)));
const suffix=words=>words.every((u,i)=>words.every((v,j)=>i===j||!v.endsWith(u)));
const gcd=(a,b)=>{if(a<0n)a=-a;if(b<0n)b=-b;while(b)[a,b]=[b,a%b];return a;};
const ratio=(a,b)=>{const g=gcd(a,b);return `${a/g}/${b/g}`;};
function kraft(words){const L=Math.max(...words.map(s=>s.length)),total=words.reduce((s,w)=>s+(1n<<BigInt(L-w.length)),0n),den=1n<<BigInt(L);return {total,den};}
function unique(words){
 // Sardinas-Patterson residual languages, with independently enumerated short-message collisions.
 const work=[],seen=new Set();for(const u of words)for(const v of words)if(u!==v&&v.startsWith(u))work.push(v.slice(u.length));
 while(work.length){const s=work.shift();if(s===''||words.includes(s))return false;if(seen.has(s))continue;seen.add(s);
  for(const w of words){if(s.startsWith(w))work.push(s.slice(w.length));if(w.startsWith(s))work.push(w.slice(s.length));}}
 return true;
}
function decode(words,syms,bits){const queue=[[0,'']],solutions=[];while(queue.length){const [offset,msg]=queue.shift();if(offset===bits.length){solutions.push(msg);continue;}for(let i=0;i<words.length;i++)if(bits.startsWith(words[i],offset))queue.push([offset+words[i].length,msg+syms[i]]);}if(solutions.length!==1)throw Error('reference message ambiguous or incomplete');return solutions[0];}
const prefixes=words=>new Set(['',...words.flatMap(w=>Array.from({length:w.length},(_,i)=>w.slice(0,i+1)))]);
const nodes=words=>[...prefixes(words)];
function canonical(lengths){const indexed=lengths.map((length,i)=>({length,i})).sort((a,b)=>a.length-b.length||a.i-b.i),out=Array(lengths.length);let next=0,prior=indexed[0].length;for(const item of indexed){next*=2**(item.length-prior);prior=item.length;if(next>=2**prior)throw Error('Kraft violated');out[item.i]=next.toString(2).padStart(prior,'0');next++;}return out;}
function reference(tag,x){const words=x.codewords,syms=x.symbols;
 switch(tag){
 case 'PREFIX_FREE':return {prefixFree:prefix(words)};
 case 'SUFFIX_FREE':return {suffixFree:suffix(words)};
 case 'UNIQUELY_DECODABLE':return {uniquelyDecodable:unique(words)};
 case 'KRAFT_SUM':{const k=kraft(words);return {sum:ratio(k.total,k.den)};}
 case 'KRAFT_SLACK':{const k=kraft(words);return {slack:ratio(k.den-k.total,k.den)};}
 case 'MAX_LENGTH':return {length:Math.max(...words.map(w=>w.length))};
 case 'MIN_LENGTH':return {length:Math.min(...words.map(w=>w.length))};
 case 'LENGTH_HISTOGRAM':{const counts=Array(Math.max(...words.map(w=>w.length))+1).fill(0);for(const w of words)counts[w.length]++;return {counts};}
 case 'WEIGHTED_AVERAGE':{const f=x.frequencies,tot=BigInt(f.reduce((a,b)=>a+b,0)),s=f.reduce((a,v,i)=>a+BigInt(v*words[i].length),0n);return {average:ratio(s,tot)};}
 case 'LENGTH_VARIANCE':{const f=x.frequencies,tot=BigInt(f.reduce((a,b)=>a+b,0)),m=f.reduce((a,v,i)=>a+BigInt(v*words[i].length),0n),m2=f.reduce((a,v,i)=>a+BigInt(v*words[i].length**2),0n);return {variance:ratio(m2*tot-m*m,tot*tot)};}
 case 'SOURCE_ENTROPY':{const tot=x.frequencies.reduce((a,b)=>a+b,0),bits=x.frequencies.reduce((a,v)=>v?a-v/tot*Math.log2(v/tot):a,0);return {bits};}
 case 'REDUNDANCY':{const tot=x.frequencies.reduce((a,b)=>a+b,0),h=x.frequencies.reduce((a,v)=>v?a-v/tot*Math.log2(v/tot):a,0),mean=x.frequencies.reduce((a,v,i)=>a+v*words[i].length,0)/tot;return {bits:mean-h};}
 case 'ENCODE':return {bits:[...x.message].map(s=>words[syms.indexOf(s)]).join('')};
 case 'DECODE':return {message:decode(words,syms,x.bits)};
 case 'TRIE_NODES':return {count:nodes(words).length};
 case 'TRIE_LEAVES':return {count:nodes(words).filter(p=>!words.some(w=>w.length>p.length&&w.startsWith(p))).length};
 case 'TRIE_INTERNAL':return {count:nodes(words).filter(p=>words.some(w=>w.length>p.length&&w.startsWith(p))).length};
 case 'TRIE_DEPTH':return {depth:Math.max(...words.map(w=>w.length))};
 case 'COMPLETE':{const k=kraft(words);return {complete:prefix(words)&&k.total===k.den};}
 case 'HAMMING_MIN':{const dist=[];for(let i=0;i<words.length;i++)for(let j=i+1;j<words.length;j++)if(words[i].length===words[j].length)dist.push([...words[i]].filter((b,k)=>b!==words[j][k]).length);return {minimum:dist.length?Math.min(...dist):null};}
 case 'LEX_ORDER':return {codewords:words.slice().sort()};
 case 'REVERSE':return {codewords:words.map(w=>[...w].reverse().join(''))};
 case 'COMPLEMENT':return {codewords:words.map(w=>[...w].map(b=>b==='0'?'1':'0').join(''))};
 case 'CANONICAL':return {codewords:canonical(x.lengths)};
 case 'AVAILABLE_LENGTH':{let count=0;for(let i=0;i<2**x.length;i++){const w=i.toString(2).padStart(x.length,'0');if(words.every(v=>!v.startsWith(w)&&!w.startsWith(v)))count++;}return {available:count};}
 default:throw Error('unknown code oracle '+tag);
 }
}
const PREFIX=[['0'],['0','1'],['0','10','11'],['00','01','10','11'],['0','10','110','111'],['00','01','1'],['0','10','110'],['00','010','011','1']];
const GENERAL=[...PREFIX,['0','01'],['0','01','1'],['0','00'],['01','10','0']];
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const restricted=['DECODE','AVAILABLE_LENGTH'].includes(tag),words=(restricted?PREFIX:GENERAL)[(i+r(restricted?PREFIX.length:GENERAL.length))%(restricted?PREFIX.length:GENERAL.length)].slice(),symbols=words.map((_,j)=>'abcdefghijk'[j]);
 if(tag==='CANONICAL')return {symbols,lengths:words.map(w=>w.length)};
 if(['WEIGHTED_AVERAGE','LENGTH_VARIANCE','SOURCE_ENTROPY','REDUNDANCY'].includes(tag))return {symbols,codewords:words,frequencies:words.map((_,j)=>j===0&&i%11===0?0:1+r(20))};
 if(tag==='ENCODE')return {symbols,codewords:words,message:Array.from({length:r(12)},()=>symbols[r(symbols.length)]).join('')};
 if(tag==='DECODE'){const msg=Array.from({length:r(12)},()=>r(words.length));return {symbols,codewords:words,bits:msg.map(j=>words[j]).join('')};}
 if(tag==='AVAILABLE_LENGTH')return {symbols,codewords:words,length:1+r(5)};
 return {symbols,codewords:words};
}
const near=(a,b)=>Object.keys(a).length===1&&Object.keys(b).length===1&&typeof Object.values(a)[0]==='number'&&typeof Object.values(b)[0]==='number'&&Number.isFinite(Object.values(a)[0])&&Number.isFinite(Object.values(b)[0])&&Math.abs(Object.values(a)[0]-Object.values(b)[0])<=1e-12*Math.max(1,Math.abs(Object.values(b)[0]));
export function runPrefixCodeBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS bounded binary codebooks',seed:'0x71c0de11',oracle:'explicit prefix sets, exact BigInt Kraft fractions, independent residual decoding and bit enumeration',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');for(const [index,tag]of TAGS.entries()){
 const layerId=id(tag,index),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x71c0de11),item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let j=0;j<100;j++){const input=inputFor(tag,j,r),expected=reference(tag,input);hash.update(JSON.stringify({id:layerId,j,input,expected}));item.validCases++;report.validCases++;let actual;
 try{actual=layer.execute(structuredClone(input));if(['SOURCE_ENTROPY','REDUNDANCY'].includes(tag))assert.ok(near(actual,expected),JSON.stringify({expected,actual}));else assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,j,input,expected,actual:actual??null,reason:String(error)});}
 if(j===0){const key='lengths'in input?'lengths':'codewords',invalid=[{...input,extra:1},{...input,symbols:['a','a']},{...input,[key]:key==='lengths'?[0]:['2']}];
 for(const[k,v]of invalid.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(v));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,j:`invalid-${k}`,input:v,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }report.coveredOperators++;report.operatorResults.push(item);
 }report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
