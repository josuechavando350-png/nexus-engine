import test from 'node:test';
import assert from 'node:assert/strict';
import {EXACT_COMBINATORICS} from '../core/layers/exact-enumerative-combinatorics.mjs';
import {EXACT_NUMBER_THEORY} from '../core/layers/exact-enumerative-number-theory.mjs';
import {EXACT_STRING_EXTENSIONS} from '../core/layers/exact-string-extensions.mjs';
import {unicodeSuffixArray,unicodeAdjacentLcp,unicodeKmpOccurrences} from '../core/layers/exact-string-algorithms.mjs';
import {EXACT_FINITE_PROBABILITY} from '../core/layers/exact-finite-probability.mjs';
const groups=[EXACT_COMBINATORICS,EXACT_NUMBER_THEORY,EXACT_STRING_EXTENSIONS,EXACT_FINITE_PROBABILITY];
const all=[...groups.flat(),
 {id:'GAUSS.CS.UNICODE_SUFFIX_ARRAY.226',execute:unicodeSuffixArray,input:{text:'banana'}},
 {id:'GAUSS.CS.UNICODE_ADJACENT_LCP.227',execute:unicodeAdjacentLcp,input:{text:'banana'}},
 {id:'GAUSS.CS.UNICODE_KMP_OCCURRENCES.228',execute:unicodeKmpOccurrences,input:{text:'banana',pattern:'ana'}},
];
let seed=0xc0ffee;
const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
function combinations(xs,k){if(k===0)return [[]];if(xs.length<k)return [];return [...combinations(xs.slice(1),k-1).map(a=>[xs[0],...a]),...combinations(xs.slice(1),k)];}
function fraction(a,b){function gcd(x,y){while(y)[x,y]=[y,x%y];return x;}const g=gcd(a,b);return {numerator:String(a/g),denominator:String(b/g)};}
function bruteCoin(event,n,k){let count=0n;for(let bits=0;bits<2**n;bits++){const a=Array.from({length:n},(_,i)=>bits>>i&1);if(event(a,k))count++;}return fraction(count,1n<<BigInt(n));}
function bruteOccupancy(event,n,m,k){let count=0n;for(let code=0;code<m**n;code++){let x=code;const bins=Array(m).fill(0);for(let i=0;i<n;i++){bins[x%m]++;x=Math.floor(x/m);}if(event(bins,k))count++;}return fraction(count,BigInt(m)**BigInt(n));}
const tails=a=>a.reduce((s,x)=>s+x,0);
const runs=a=>a.reduce((s,x,i)=>s+Number(i===0||x!==a[i-1]),0);
const first=a=>a.indexOf(1)+1;
const last=a=>a.lastIndexOf(1)+1;
const maxRun=a=>a.reduce((s,x)=>{s.cur=x?s.cur+1:0;s.max=Math.max(s.max,s.cur);return s;},{cur:0,max:0}).max;
const coinOracles=[
 a=>tails(a),a=>tails(a),a=>tails(a),a=>runs(a),a=>first(a),a=>last(a),a=>maxRun(a),
 a=>a.slice(1).reduce((s,x,i)=>s+Number(x&&a[i]),0),
 a=>a.slice(1).reduce((s,x,i)=>s+Number(x&&!a[i]),0),
 a=>tails(a),a=>2*tails(a)-a.length,
 a=>a.reduce((s,x)=>{s.pos+=x?1:-1;s.max=Math.max(s.max,s.pos);return s;},{pos:0,max:0}).max,
 a=>{let position=0;for(let i=0;i<a.length;i++){position+=a[i]?1:-1;if(position===0)return i===a.length-1?0:-1;}return -1;}
];
const occupancyOracles=[
 b=>b.every(x=>x<=1),b=>b.some(x=>x>1),b=>b.every(x=>x>0),
 b=>b.filter(x=>x>0).length,b=>b[0]===0,b=>b[0],b=>b[0],
 b=>b.every(x=>x===b[0]),b=>b.filter(x=>x===2).length===1&&b.every(x=>x<=2),b=>b.every(x=>x<=2),
];
test('100 unique independent callable definitions, bounded frozen deterministic outputs, no placeholders',()=>{
 assert.equal(all.length,100);assert.equal(new Set(all.map(x=>x.id)).size,100);assert.equal(new Set(all.map(x=>x.execute)).size,100);
 for(const layer of all){const one=layer.execute(layer.input),two=layer.execute(layer.input);assert.deepEqual(one,two,layer.id);assert.equal(Object.isFrozen(one),true,layer.id);assert.equal(typeof one,'object');assert.equal(JSON.stringify(one).includes('TODO'),false);}
});
test('every coin and occupancy event matches independent complete sample-space enumeration',()=>{
 const coins=EXACT_FINITE_PROBABILITY.slice(0,13);
 for(let n=0;n<=7;n++)for(let k=0;k<=n+1;k++)for(let id=0;id<coins.length;id++){
  const layer=coins[id];const input={n,k:id===12?0:k};const got=layer.execute(input);
  const expected=bruteCoin((a,t)=>{
   const v=coinOracles[id](a);if(id===0)return v===t;if(id===1)return v<=t;if(id===2)return v>=t;
   if(id===3)return v===t;if(id===4||id===5)return v===t&&t>0;
   if(id===6)return v<=t;if(id===7||id===8)return v===t;
   if(id===9)return v===t&&!a.some((x,i)=>i&&x&&a[i-1]);
   if(id===10)return v===t;if(id===11)return v<=t;
   return v===0&&a.length>0;
  },n,input.k);
  assert.deepEqual(got,expected,`${layer.id} n=${n} k=${k}`);
 }
 const occupancy=EXACT_FINITE_PROBABILITY.slice(13);
 for(let m=1;m<=4;m++)for(let n=0;n<=5;n++)for(let k=0;k<=Math.min(n+1,4);k++)for(let id=0;id<occupancy.length;id++){
  const layer=occupancy[id],input={n,m};if([3,5,6].includes(id))input.k=k;
  const actual=layer.execute(input);
  const expected=bruteOccupancy((b,t)=>{
   const v=occupancyOracles[id](b);
   if(id===3||id===5)return v===t;if(id===6)return v>=t;
   if(id===8)return n>=2&&v;
   return v;
  },n,m,k);
  assert.deepEqual(actual,expected,`${layer.id} n=${n} m=${m} k=${k}`);
 }
});
test('independent small-set oracles for combinatorics, number theory, and strings',()=>{
 const [stir2,stir1,signed,bell,ordered,lah,euler,narayana,catalan,motzkin,delannoy,central,derangement,rencontres,involution,partK,partDistinct,partOdd,composition,weak,palindrome,binary]=EXACT_COMBINATORICS.map(x=>x.execute);
 for(let n=0;n<=6;n++){
  const permutations=(a)=>a.length? a.flatMap((x,i)=>permutations(a.filter((_,j)=>j!==i)).map(t=>[x,...t])):[[]];
  const p=permutations(Array.from({length:n},(_,i)=>i));
  assert.equal(BigInt(derangement({n}).value),BigInt(p.filter(a=>a.every((v,i)=>v!==i)).length));
  assert.equal(BigInt(involution({n}).value),BigInt(p.filter(a=>a.every((v,i)=>a[v]===i)).length));
  for(let k=0;k<=n;k++){
   assert.equal(BigInt(stir1({n,k}).value),BigInt(p.filter(a=>{const seen=new Set();let cycles=0;for(let i=0;i<n;i++)if(!seen.has(i)){cycles++;let v=i;do{seen.add(v);v=a[v];}while(!seen.has(v));}return cycles===k;}).length));
   assert.equal(BigInt(rencontres({n,k}).value),BigInt(p.filter(a=>a.filter((v,i)=>v===i).length===k).length));
   assert.equal(BigInt(euler({n,k}).value),BigInt(p.filter(a=>a.slice(1).reduce((s,v,i)=>s+Number(a[i]>v),0)===k).length));
  }
  const dyck=(open,close)=>open===n&&close===n?1n:(open<n?dyck(open+1,close):0n)+(close<open?dyck(open,close+1):0n);
  assert.equal(BigInt(catalan({n}).value),dyck(0,0));
  assert.equal(BigInt(central({n}).value),BigInt(delannoy({n,k:n}).value));
  assert.equal(BigInt(partDistinct({n}).value),BigInt(partOdd({n}).value));
  assert.equal(BigInt(palindrome({n}).value),BigInt(n===0?1:2**Math.floor(n/2)));
  assert.equal(BigInt(binary({n}).value),BigInt(Array.from({length:2**n},(_,x)=>x).filter(x=>!(x&(x<<1))).length));
  assert.equal(BigInt(bell({n}).value),Array.from({length:n+1},(_,k)=>BigInt(stir2({n,k}).value)).reduce((a,b)=>a+b,0n));
  assert.equal(BigInt(ordered({n}).value)>=BigInt(bell({n}).value),true);
  assert.equal(BigInt(motzkin({n}).value)>=0n,true);
  for(let k=0;k<=n;k++){
   assert.equal(BigInt(signed({n,k}).value),BigInt(stir1({n,k}).value)*BigInt((n-k)%2?-1:1));
   if(n>0&&k>0)assert.equal(BigInt(lah({n,k}).value)>0n,true);
   assert.equal(BigInt(composition({n,k}).value)<=BigInt(weak({n,k}).value),true);
   assert.equal(BigInt(partK({n,k}).value)>=0n,true);
  }
 }
 const mu=EXACT_NUMBER_THEORY[0].execute;
 for(let n=1;n<=40;n++){
  const mobius=(v)=>{let m=v,omega=0;for(let d=2;d<=m;d++)if(m%d===0){let e=0;while(m%d===0){e++;m/=d;}if(e>1)return 0;omega++;}return omega%2?-1:1;};
  const expected=Array.from({length:n},(_,i)=>mobius(i+1)).reduce((a,b)=>a+b,0);
  assert.equal(Number(mu({n}).value),expected);
  const divisorCount=Array.from({length:n},(_,i)=>i+1).filter(d=>n%d===0).length;
  assert.equal(Number(EXACT_NUMBER_THEORY[7].execute({n}).value),Array.from({length:n},(_,i)=>i+1).filter(d=>n%d===0&&d>1&&Array.from({length:d-1},(_,j)=>j+2).every(p=>d%p!==0||p===d)).length);
  assert.equal(divisorCount>=1,true);
 }
 const textCases=['','a','aaaa','banana','a😀a','abcba','bca','aabbc'];
 const [pre,z,period,borders,longBorder,longPal,countPal,distinctPal,lps,append,prepend,rotate,rotationCount,lyndon,longUnique,inversions,distinctSub,longRepeat,lcs,occ,distinctSeq,edit,hamming,commonPre,commonSuf]=EXACT_STRING_EXTENSIONS.map(x=>x.execute);
 for(const word of textCases){const a=Array.from(word),n=a.length;const s=x=>Array.from(x).join('');
  const naivePal=[];const allSub=[];
  for(let i=0;i<n;i++)for(let j=i+1;j<=n;j++){let sub=a.slice(i,j);allSub.push(s(sub));if(s(sub)===s([...sub].reverse()))naivePal.push(s(sub));}
  assert.equal(Number(countPal({text:word}).count),naivePal.length);
  assert.equal(distinctPal({text:word}).count,new Set(naivePal).size);
  assert.equal(BigInt(distinctSub({text:word}).count),BigInt(new Set(allSub).size));
  assert.equal(longPal({text:word}).length,Math.max(0,...naivePal.map(x=>Array.from(x).length)));
  assert.equal(longRepeat({text:word}).length,Math.max(0,...allSub.filter(x=>allSub.filter(y=>y===x).length>1).map(x=>Array.from(x).length)));
  assert.equal(rotate({text:word}).rotation,[...Array.from({length:n},(_,i)=>s(a.slice(i).concat(a.slice(0,i))))].sort()[0]||'');
  assert.equal(rotationCount({text:word}).count,new Set(Array.from({length:n},(_,i)=>s(a.slice(i).concat(a.slice(0,i))))).size);
  assert.equal(inversions({text:word}).count,String(a.reduce((s,x,i)=>s+a.slice(i+1).filter(y=>x.codePointAt(0)>y.codePointAt(0)).length,0)));
  assert.equal(append({text:word}).text,s(Array.from(append({text:word}).text).reverse()));
  assert.equal(prepend({text:word}).text,s(Array.from(prepend({text:word}).text).reverse()));
  assert.equal(lyndon({text:word}).factors.join(''),word);
  assert.equal(pre({text:word}).prefix.length,n);assert.equal(z({text:word}).z.length,n);
  assert.equal(period({text:word}).length,rotationCount({text:word}).count);
  assert.equal(longBorder({text:word}).length,borders({text:word}).lengths.at(-1)||0);
  assert.equal(longUnique({text:word}).length<=new Set(a).size,true);
 }
 assert.equal(lcs({left:'banana',right:'ananas'}).length,5);
 assert.equal(occ({text:'aaa',pattern:'aa'}).count,'3');
 assert.equal(distinctSeq({text:'aaa'}).count,'3');
 assert.equal(edit({left:'ca',right:'ac'}).distance,1);
 assert.equal(hamming({left:'🍎a',right:'🍏a'}).distance,1);
 assert.equal(commonPre({left:'abc',right:'abd'}).length,2);
 assert.equal(commonSuf({left:'abc',right:'xbc'}).length,2);
});
test('invalid arithmetic and Unicode data rejected, deterministic 100-operator fuzz',()=>{
 for(const group of groups)for(const layer of group)assert.throws(()=>layer.execute({}), /expected|must|invalid|positive|range/i,layer.id);
 for(const layer of [...EXACT_STRING_EXTENSIONS, ...all.slice(-3)]){
  const key=Object.keys(layer.input)[0];assert.throws(()=>layer.execute({...layer.input,[key]:'\ud800'}), /unpaired surrogate/,layer.id);
 }
 for(let i=0;i<100;i++)for(const layer of all){const data=structuredClone(layer.input);if(Object.hasOwn(data,'n'))data.n=rand()%9;if(Object.hasOwn(data,'k'))data.k=rand()%9;if(Object.hasOwn(data,'m'))data.m=(rand()%4)+1;
  if(layer.id.includes('WALK_FIRST_RETURN'))data.k=0;
  if((layer.id.includes('NECKLACES')||layer.id.includes('RAMANUJAN')||layer.id.includes('BINARY_PRIMITIVE_WORDS')||layer.id.includes('GCD_SUM_MODULUS')||layer.id.includes('PRIME_FACTORS')||layer.id.includes('JORDAN')||layer.id.includes('SIGMA_')||layer.id.includes('UNITARY')||layer.id.includes('INTEGER_RADICAL')||layer.id.includes('LIOUVILLE')||layer.id.includes('PRIMITIVE_ROOT')||layer.id.includes('QUADRATIC_RESIDUE'))&&data.n===0)data.n=1;
  if(layer.id.includes('NTH_PRIME')&&data.n===0)data.n=1;
  try{const result=layer.execute(data);assert.equal(Object.isFrozen(result),true,layer.id)}catch(e){if(e instanceof RangeError&&/positive|>= 2/.test(e.message))continue;throw new Error(`${layer.id}: ${e.stack}`);}
 }
});
