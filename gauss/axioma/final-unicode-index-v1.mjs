/* Unicode code-point lexicographic suffixes and overlapping substring matches by exhaustive comparisons. */
import {runFinalBank,range} from './final-common-v1.mjs';
const tags=['UNICODE_SUFFIX_ARRAY','UNICODE_ADJACENT_LCP','UNICODE_KMP_OCCURRENCES'];
const alphabet=['a','b','c','ñ','🙂','𝄞','é'];
function reference(tag,x){const text=Array.from(x.text),indices=range(text.length).sort((a,b)=>{let i=a,j=b;while(i<text.length&&j<text.length){const aa=text[i].codePointAt(0),bb=text[j].codePointAt(0);if(aa!==bb)return aa-bb;i++;j++;}return Number(i<text.length)-Number(j<text.length);});
 if(tag==='UNICODE_SUFFIX_ARRAY')return {indices,unit:'UNICODE_CODE_POINT'};
 if(tag==='UNICODE_ADJACENT_LCP'){const lcp=indices.map((p,i)=>{if(i===0)return 0;let j=indices[i-1],k=0;while(p+k<text.length&&j+k<text.length&&text[p+k]===text[j+k])k++;return k;});return {indices,lcp,unit:'UNICODE_CODE_POINT'};}
 const pattern=Array.from(x.pattern),positions=[];for(let i=0;i+pattern.length<=text.length;i++)if(pattern.every((symbol,j)=>text[i+j]===symbol))positions.push(i);
 return {positions,count:positions.length,unit:'UNICODE_CODE_POINT'};
}
function sample(tag,i,r){const n=r(17),text=range(n).map(()=>alphabet[r(alphabet.length)]).join('');if(tag==='UNICODE_KMP_OCCURRENCES'){const chars=Array.from(text),pattern=(i%4===0&&chars.length?chars.slice(r(chars.length),r(4)+1):range(1+r(4)).map(()=>alphabet[r(alphabet.length)])).join('');return {text,pattern:pattern||'🙂'};}return {text};}
const definitions=tags.map((tag,i)=>({id:`GAUSS.CS.${tag}.${226+i}`,make:(j,r)=>sample(tag,j,r),reference:x=>reference(tag,x)}));
export const runFinalUnicodeIndexBank=options=>runFinalBank({name:'AXIOMA 3 Unicode suffix/LCP/KMP brute force references',definitions,...options});
