/* Oracle works on explicit bit strings, not GAUSS bitwise kernels. */
import {runBatchBank,seq,frac} from './batch-238-common.mjs';
const tags=['BIT_POPCOUNT','BIT_PARITY','BIT_LEADING_ZEROS','BIT_TRAILING_ZEROS','BIT_MSB','BIT_LSB','BIT_REVERSE','BIT_COMPLEMENT','BIT_ROTL','BIT_ROTR','BIT_GRAY_ENCODE','BIT_GRAY_DECODE','BIT_ONE_POSITIONS','BIT_ZERO_POSITIONS','BIT_LONGEST_ONE_RUN','BIT_LONGEST_ZERO_RUN','BIT_LINEAR_TRANSITIONS','BIT_CIRCULAR_TRANSITIONS','BIT_HAMMING_DISTANCE','BIT_INTERSECTION_SIZE','BIT_UNION_SIZE','BIT_JACCARD','BIT_RANK','BIT_SELECT','BIT_PREFIX_PARITIES'];
const bitArray=(w,v)=>Array.from(v.toString(2).padStart(w,'0')).reverse().map(Number);
const number=a=>a.reduce((n,b,i)=>n+(b?2**i:0),0);
const count=a=>a.reduce((n,b)=>n+b,0);
const longest=(a,b)=>{let best=0,cur=0;for(const x of a){cur=x===b?cur+1:0;best=Math.max(best,cur);}return best;};
const positions=(a,v)=>a.flatMap((b,i)=>b===v?[i]:[]);
const pairTags=new Set(['BIT_HAMMING_DISTANCE','BIT_INTERSECTION_SIZE','BIT_UNION_SIZE','BIT_JACCARD']);
const kTags=new Set(['BIT_ROTL','BIT_ROTR','BIT_RANK','BIT_SELECT']);
function input(tag,i,r){const width=[1,2,3,7,8,16,31,32][i%8],max=2**width,mode=i%11;const value=mode===0?0:mode===1?max-1:mode===2?2**(i%width):mode===3?Math.floor((max-1)/3):r(max);if(pairTags.has(tag))return {width,left:value,right:i%4===0?value:r(max)};if(kTags.has(tag))return {width,value,k:i%7===0?0:i%7===1?width:r(width+1)};return {width,value};}
function reference(tag,x){const w=x.width,a=bitArray(w,x.value??x.left),b=pairTags.has(tag)?bitArray(w,x.right):null;
 switch(tag){
 case 'BIT_POPCOUNT':return {count:count(a)};
 case 'BIT_PARITY':return {parity:count(a)%2};
 case 'BIT_LEADING_ZEROS':return {count:positions(a,1).length?w-1-positions(a,1).at(-1):w};
 case 'BIT_TRAILING_ZEROS':return {count:positions(a,1)[0]??w};
 case 'BIT_MSB':return {index:positions(a,1).at(-1)??null};
 case 'BIT_LSB':return {index:positions(a,1)[0]??null};
 case 'BIT_REVERSE':return {value:number(a.slice().reverse())};
 case 'BIT_COMPLEMENT':return {value:number(a.map(v=>1-v))};
 case 'BIT_ROTL':return {value:number(seq(w).map(i=>a[(i-x.k+w)%w]))};
 case 'BIT_ROTR':return {value:number(seq(w).map(i=>a[(i+x.k)%w]))};
 case 'BIT_GRAY_ENCODE':return {value:number(a.map((v,i)=>v^(a[i+1]??0)))};
 case 'BIT_GRAY_DECODE':{const out=Array(w);out[w-1]=a[w-1];for(let i=w-2;i>=0;i--)out[i]=out[i+1]^a[i];return {value:number(out)};}
 case 'BIT_ONE_POSITIONS':return {positions:positions(a,1)};
 case 'BIT_ZERO_POSITIONS':return {positions:positions(a,0)};
 case 'BIT_LONGEST_ONE_RUN':return {length:longest(a,1)};
 case 'BIT_LONGEST_ZERO_RUN':return {length:longest(a,0)};
 case 'BIT_LINEAR_TRANSITIONS':return {count:seq(w-1).filter(i=>a[i]!==a[i+1]).length};
 case 'BIT_CIRCULAR_TRANSITIONS':return {count:seq(w).filter(i=>a[i]!==a[(i+1)%w]).length};
 case 'BIT_HAMMING_DISTANCE':return {distance:seq(w).filter(i=>a[i]!==b[i]).length};
 case 'BIT_INTERSECTION_SIZE':return {count:seq(w).filter(i=>a[i]&&b[i]).length};
 case 'BIT_UNION_SIZE':return {count:seq(w).filter(i=>a[i]||b[i]).length};
 case 'BIT_JACCARD':{const both=seq(w).filter(i=>a[i]&&b[i]).length,either=seq(w).filter(i=>a[i]||b[i]).length;return {similarity:frac(both,either||1)};}
 case 'BIT_RANK':return {rank:count(a.slice(0,x.k))};
 case 'BIT_SELECT':return {position:positions(a,1)[x.k]??null};
 case 'BIT_PREFIX_PARITIES':{let p=0;return {parities:a.map(v=>(p+=v)%2)};}
 default:throw Error(`missing independent bitword reference: ${tag}`);
 }
}
export const runBitword238Bank=options=>runBatchBank({name:'AXIOMA bitwords 726-750',prefix:'INFO',start:726,tags,input,reference,...options});
