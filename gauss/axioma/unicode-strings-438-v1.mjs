/* Independent Unicode scalar oracles via direct substring, subsequence and cut enumeration. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['PREFIX_FUNCTION','Z_FUNCTION','MINIMUM_PERIOD','BORDER_LENGTHS','LONGEST_BORDER','LONGEST_PALINDROME','PALINDROME_SUBSTRING_COUNT','DISTINCT_PALINDROMES','PALINDROMIC_SUBSEQUENCE_LENGTH','PALINDROME_APPEND','PALINDROME_PREPEND','MINIMUM_ROTATION','DISTINCT_ROTATIONS','LYNDON_FACTORIZATION','LONGEST_UNIQUE_SPAN','CODEPOINT_INVERSIONS','DISTINCT_SUBSTRINGS','LONGEST_REPEATED_SUBSTRING','LONGEST_COMMON_SUBSTRING','SUBSEQUENCE_OCCURRENCES','DISTINCT_SUBSEQUENCES','OSA_EDIT_DISTANCE','HAMMING_DISTANCE','COMMON_PREFIX_LENGTH','COMMON_SUFFIX_LENGTH'];
const cp=s=>[...s],text=a=>a.join(''),eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]),pal=a=>eq(a,a.slice().reverse());
const parts=a=>seq(a.length).flatMap(i=>seq(a.length-i).map(j=>({start:i,end:i+j+1,values:a.slice(i,i+j+1)})));
const subsequences=a=>seq(2**a.length).map(m=>a.filter((_,i)=>m&(1<<i)));
const compare=(a,b)=>{for(let i=0;i<Math.min(a.length,b.length);i++){const x=a[i].codePointAt(0)-b[i].codePointAt(0);if(x)return Math.sign(x);}return Math.sign(a.length-b.length);};
const rotations=a=>seq(a.length).map(i=>a.slice(i).concat(a.slice(0,i)));
const lyndon=a=>a.length>0&&rotations(a).slice(1).every(r=>compare(a,r)<0);
function input(tag,i,r){const alphabet=['a','b','c','😀'],n=i%11===0?0:i%7+1,random=m=>text(seq(m).map(()=>alphabet[r(alphabet.length)])),a=random(n),b=random(i%5),x={text:a};
 if(['LONGEST_COMMON_SUBSTRING','OSA_EDIT_DISTANCE','HAMMING_DISTANCE','COMMON_PREFIX_LENGTH','COMMON_SUFFIX_LENGTH'].includes(tag))return {left:a,right:tag==='HAMMING_DISTANCE'?random(n):b};
 if(tag==='SUBSEQUENCE_OCCURRENCES')return {text:a,pattern:i%7===0?'':random(i%4)};
 return x;
}
function reference(tag,x){const a=cp(x.text??x.left),b=cp(x.right??x.pattern??''),segments=parts(a),ps=segments.filter(s=>pal(s.values)),subs=subsequences(a),prefix=k=>eq(a.slice(0,k),a.slice(a.length-k));
 switch(tag){
 case 'PREFIX_FUNCTION':return {prefix:seq(a.length).map(i=>seq(i+1).filter(k=>k&&eq(a.slice(0,k),a.slice(i-k+1,i+1))).at(-1)??0)};
 case 'Z_FUNCTION':return {z:seq(a.length).map(i=>i===0?a.length:seq(a.length-i).filter(k=>eq(a.slice(0,k+1),a.slice(i,i+k+1))).length)};
 case 'MINIMUM_PERIOD':return {length:a.length?(seq(a.length).find(k=>k>0&&a.length%k===0&&a.every((v,i)=>v===a[i%k]))??a.length):0};
 case 'BORDER_LENGTHS':return {lengths:seq(a.length).filter(k=>k>0&&prefix(k))};
 case 'LONGEST_BORDER':return {length:Math.max(0,...seq(a.length).filter(k=>k>0&&prefix(k)))};
 case 'LONGEST_PALINDROME':{const p=ps.slice().sort((u,v)=>v.values.length-u.values.length||u.start-v.start)[0];return {start:p?.start??0,length:p?.values.length??0,substring:text(p?.values??[])};}
 case 'PALINDROME_SUBSTRING_COUNT':return {count:String(ps.length)};
 case 'DISTINCT_PALINDROMES':return {count:new Set(ps.map(s=>text(s.values))).size};
 case 'PALINDROMIC_SUBSEQUENCE_LENGTH':return {length:Math.max(0,...subs.filter(pal).map(s=>s.length))};
 case 'PALINDROME_APPEND':{for(let cut=0;cut<=a.length;cut++){const addition=a.slice(0,cut).reverse(),candidate=a.concat(addition);if(pal(candidate))return {added:cut,text:text(candidate)};}throw Error('no append palindrome');}
 case 'PALINDROME_PREPEND':{for(let cut=0;cut<=a.length;cut++){const addition=a.slice(a.length-cut).reverse(),candidate=addition.concat(a);if(pal(candidate))return {added:cut,text:text(candidate)};}throw Error('no prepend palindrome');}
 case 'MINIMUM_ROTATION':{const best=rotations(a).map((v,i)=>({v,i})).sort((u,v)=>compare(u.v,v.v)||u.i-v.i)[0];return {start:best?.i??0,rotation:text(best?.v??[])};}
 case 'DISTINCT_ROTATIONS':return {count:new Set(rotations(a).map(text)).size};
 case 'LYNDON_FACTORIZATION':{if(!a.length)return {factors:[]};const valid=[];for(let mask=0;mask<2**(a.length-1);mask++){const cuts=[0,...seq(a.length-1).filter(i=>mask&(1<<i)).map(i=>i+1),a.length],f=cuts.slice(1).map((v,i)=>a.slice(cuts[i],v));if(f.every(lyndon)&&f.slice(1).every((v,i)=>compare(f[i],v)>=0))valid.push(f.map(text));}assert.equal(valid.length,1,'unique Chen-Fox-Lyndon decomposition');return {factors:valid[0]};}
 case 'LONGEST_UNIQUE_SPAN':{const p=segments.filter(s=>new Set(s.values).size===s.values.length).sort((u,v)=>v.values.length-u.values.length||u.start-v.start)[0];return {start:p?.start??0,length:p?.values.length??0};}
 case 'CODEPOINT_INVERSIONS':return {count:String(a.reduce((s,v,i)=>s+a.slice(i+1).filter(w=>v.codePointAt(0)>w.codePointAt(0)).length,0))};
 case 'DISTINCT_SUBSTRINGS':return {count:String(new Set(segments.map(s=>text(s.values))).size)};
 case 'LONGEST_REPEATED_SUBSTRING':{const repeats=segments.filter(s=>segments.filter(t=>eq(t.values,s.values)).length>1).sort((u,v)=>v.values.length-u.values.length||u.start-v.start);const p=repeats[0];return {length:p?.values.length??0,substring:text(p?.values??[])};}
 case 'LONGEST_COMMON_SUBSTRING':{const common=segments.filter(s=>parts(b).some(t=>eq(s.values,t.values))).sort((u,v)=>v.values.length-u.values.length||u.start-v.start)[0];return {length:common?.values.length??0,substring:text(common?.values??[])};}
 case 'SUBSEQUENCE_OCCURRENCES':{const p=cp(x.pattern);return {count:String(subs.filter(s=>s.length===p.length&&eq(s,p)).length)};}
 case 'DISTINCT_SUBSEQUENCES':return {count:String(new Set(subs.filter(s=>s.length).map(text)).size)};
 case 'OSA_EDIT_DISTANCE':{const d=seq(a.length+1).map(i=>seq(b.length+1).map(j=>i+j));for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+Number(a[i-1]!==b[j-1]));if(i>=2&&j>=2&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);}return {distance:d[a.length][b.length]};}
 case 'HAMMING_DISTANCE':return {distance:a.filter((v,i)=>v!==b[i]).length};
 case 'COMMON_PREFIX_LENGTH':return {length:seq(Math.min(a.length,b.length)).filter(k=>eq(a.slice(0,k+1),b.slice(0,k+1))).length};
 case 'COMMON_SUFFIX_LENGTH':return {length:seq(Math.min(a.length,b.length)).filter(k=>eq(a.slice(a.length-k-1),b.slice(b.length-k-1))).length};
 default:throw Error('missing Unicode reference '+tag);
 }
}
function verify(tag,input,actual,expected){if(['LONGEST_REPEATED_SUBSTRING','LONGEST_COMMON_SUBSTRING','LONGEST_PALINDROME'].includes(tag)){assert.equal(actual.length,expected.length);assert.equal(cp(actual.substring).length,expected.length);if(tag==='LONGEST_REPEATED_SUBSTRING'){const s=cp(input.text),p=cp(actual.substring);assert.ok(seq(s.length-p.length+1).filter(i=>eq(s.slice(i,i+p.length),p)).length>=2||p.length===0);}else if(tag==='LONGEST_COMMON_SUBSTRING'){assert.ok(input.left.includes(actual.substring)&&input.right.includes(actual.substring));}else{assert.ok(pal(cp(actual.substring)));assert.ok(eq(cp(input.text).slice(actual.start,actual.start+actual.length),cp(actual.substring)));}return;}assert.deepStrictEqual(actual,expected);}
export const runUnicode438Bank=options=>runBatchBank({name:'AXIOMA Unicode scalar exhaustive references 201–225',prefix:'CS',start:201,tags,input,reference,verify,...options});
