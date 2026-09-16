import test from 'node:test';
import assert from 'node:assert/strict';
import {
 weightedIntervalScheduling,matrixChainMultiplication,minimumCoinChange,exactSubsetSum,
 longestIncreasingSubsequence,levenshteinDistance,longestCommonSubsequence,
 optimalHuffmanLengths,optimalSuccessfulBinarySearchTree,minimumPalindromePartition,
 johnsonTwoMachineSchedule,
} from '../core/layers/discrete-optimization.mjs';
let seed=0x19ed24ad;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2**32;}
const number=n=>Math.floor(random()*n);
test('weighted intervals agree with independent exhaustive feasible subsets for 200 schedules',()=>{
 for(let run=0;run<200;run++){
  const n=1+number(10),jobs=Array.from({length:n},(_,i)=>{let start=number(12);return {id:`j${i}`,start,end:start+1+number(6),reward:number(18)};});
  let best=0;for(let mask=0;mask<(1<<n);mask++){
   const selected=jobs.filter((_,i)=>mask&(1<<i)).sort((a,b)=>a.start-b.start);
   if(selected.some((v,i)=>i>0&&selected[i-1].end>v.start))continue;
   best=Math.max(best,selected.reduce((s,j)=>s+j.reward,0));
  }
  const got=weightedIntervalScheduling({jobs});assert.equal(got.optimalReward,best);
  const witness=got.selectedIds.map(id=>jobs.find(j=>j.id===id)).sort((a,b)=>a.start-b.start);
  assert(witness.every((j,i)=>i===0||witness[i-1].end<=j.start));
  assert.equal(witness.reduce((s,j)=>s+j.reward,0),best);
 }
});
test('matrix-chain order matches completely independent recursive parenthesization enumeration',()=>{
 for(let run=0;run<140;run++){
  const d=Array.from({length:3+number(6)},()=>1+number(20)),n=d.length-1;
  function solve(i,j){if(i===j)return 0;let best=Infinity;for(let k=i;k<j;k++)best=Math.min(best,solve(i,k)+solve(k+1,j)+d[i]*d[k+1]*d[j+1]);return best;}
  const got=matrixChainMultiplication({dimensions:d});assert.equal(got.scalarMultiplications,solve(0,n-1));
  assert.equal((got.parenthesization.match(/A\d+/g)||[]).length,n);
 }
});
test('unbounded minimum coin change matches independent breadth-first amount search',()=>{
 for(let run=0;run<150;run++){
  const amount=number(40),denominations=[...new Set(Array.from({length:1+number(6)},()=>1+number(12)))];
  const dp=Array(amount+1).fill(Infinity);dp[0]=0;const q=[0];
  for(let i=0;i<q.length;i++)for(const coin of denominations){const next=q[i]+coin;
   if(next<=amount&&dp[next]===Infinity){dp[next]=dp[q[i]]+1;q.push(next);}}
  const got=minimumCoinChange({amount,denominations});assert.equal(got.reachable,dp[amount]!==Infinity);
  assert.equal(got.minimumCoins,dp[amount]===Infinity?null:dp[amount]);
  assert.equal(got.coins.reduce((a,b)=>a+b,0),got.reachable?amount:0);
 }
});
test('exact subset-sum witness agrees with exhaustive enumeration for 200 bounded sets',()=>{
 for(let run=0;run<200;run++){
  const n=number(12),values=Array.from({length:n},()=>number(22)),target=number(80);
  let exists=false;for(let mask=0;mask<(1<<n);mask++)if(values.reduce((s,v,i)=>s+((mask&(1<<i))?v:0),0)===target){exists=true;break;}
  const got=exactSubsetSum({target,values});assert.equal(got.reachable,exists);
  assert.equal(new Set(got.selectedIndices).size,got.selectedIndices.length);
  if(got.reachable)assert.equal(got.selectedIndices.reduce((s,i)=>s+values[i],0),target);
 }
});
test('strict LIS length equals brute-force subsequence oracle on 200 sequences',()=>{
 for(let run=0;run<200;run++){
  const n=number(12),values=Array.from({length:n},()=>number(15)-5);let best=0;
  for(let mask=0;mask<(1<<n);mask++){
   const xs=values.filter((_,i)=>mask&(1<<i));if(xs.every((v,i)=>!i||xs[i-1]<v))best=Math.max(best,xs.length);
  }
  const got=longestIncreasingSubsequence({values});assert.equal(got.length,best);
  assert.deepEqual(got.subsequence,got.indices.map(i=>values[i]));
  assert(got.indices.every((v,i)=>i===0||got.indices[i-1]<v));
 }
});
test('Levenshtein distance agrees with independently memoized recursive edit enumeration',()=>{
 const alphabet=['a','b','c','💫'];
 for(let run=0;run<130;run++){
  const a=Array.from({length:number(7)},()=>alphabet[number(alphabet.length)]).join('');
  const b=Array.from({length:number(7)},()=>alphabet[number(alphabet.length)]).join('');
  const aa=[...a],bb=[...b],memo=new Map();
  function oracle(i,j){if(i===aa.length)return bb.length-j;if(j===bb.length)return aa.length-i;
   const key=`${i},${j}`;if(memo.has(key))return memo.get(key);
   const cost=aa[i]===bb[j]?oracle(i+1,j+1):1+Math.min(oracle(i+1,j),oracle(i,j+1),oracle(i+1,j+1));
   memo.set(key,cost);return cost;}
  assert.equal(levenshteinDistance({left:a,right:b}).distance,oracle(0,0));
 }
});
test('LCS witness equals longest independently enumerated subsequence on 160 strings',()=>{
 for(let run=0;run<160;run++){
  const a=Array.from({length:number(9)},()=>['a','b','c'][number(3)]).join('');
  const b=Array.from({length:number(9)},()=>['a','b','c'][number(3)]).join('');
  let best=0;for(let mask=0;mask<(1<<a.length);mask++){
   const s=[...a].filter((_,i)=>mask&(1<<i)).join('');let k=0;for(const ch of b)if(ch===s[k])k++;
   if(k===s.length)best=Math.max(best,s.length);
  }
  const got=longestCommonSubsequence({left:a,right:b});assert.equal(got.length,best);
  assert.equal(got.subsequence.length,best);
  for(const src of [a,b]){let k=0;for(const ch of src)if(ch===got.subsequence[k])k++;assert.equal(k,best);}
 }
});
test('Huffman weighted length equals exhaustive optimal merging cost on 100 distributions',()=>{
 function optimal(xs){if(xs.length<=1)return 0;let best=Infinity;
  for(let i=0;i<xs.length;i++)for(let j=i+1;j<xs.length;j++){
   const rest=xs.filter((_,k)=>k!==i&&k!==j),merged=xs[i]+xs[j];
   best=Math.min(best,merged+optimal([...rest,merged]));
  }return best;}
 for(let run=0;run<100;run++){
  const n=1+number(6),weights=Array.from({length:n},()=>1+number(9));
  const got=optimalHuffmanLengths({symbols:weights.map((weight,i)=>({id:`s${i}`,weight}))});
  assert.equal(got.weightedPathLength,optimal(weights));
  assert.equal(got.codeLengths.reduce((s,r)=>s+weights[Number(r.id.slice(1))]*r.length,0),got.weightedPathLength);
  assert.equal(new Set(got.codeLengths.map(r=>r.id)).size,n);
 }
});
test('weighted successful-search BST cost equals independent recursive root oracle',()=>{
 for(let run=0;run<140;run++){
  const weights=Array.from({length:1+number(7)},()=>number(10)),n=weights.length;
  function oracle(i,j,depth){if(i>j)return 0;let best=Infinity;
   for(let k=i;k<=j;k++)best=Math.min(best,weights[k]*depth+oracle(i,k-1,depth+1)+oracle(k+1,j,depth+1));return best;}
  const got=optimalSuccessfulBinarySearchTree({weights});assert.equal(got.weightedSearchCost,oracle(0,n-1,1));
  assert.deepEqual(got.nodes.map(n=>n.key),Array.from({length:n},(_,i)=>i));
 }
});
test('minimum palindrome partition matches independent recursive enumeration',()=>{
 for(let run=0;run<170;run++){
  const str=Array.from({length:number(10)},()=>['a','b','c'][number(3)]).join('');
  function oracle(i){if(i===str.length)return 0;let best=Infinity;for(let j=i+1;j<=str.length;j++){
   const part=str.slice(i,j);if(part===[...part].reverse().join(''))best=Math.min(best,1+oracle(j));
  }return best;}
  const got=minimumPalindromePartition({text:str});assert.equal(got.minimumParts,oracle(0));
  assert.equal(got.parts.join(''),str);assert(got.parts.every(p=>p===[...p].reverse().join('')));
 }
});
test('Johnson two-machine schedule matches independent exhaustive permutations on 130 job sets',()=>{
 for(let run=0;run<130;run++){
  const jobs=Array.from({length:1+number(7)},(_,i)=>({id:`j${i}`,first:number(10),second:number(10)}));
  function makespan(xs){let a=0,b=0;for(const j of xs){a+=j.first;b=Math.max(a,b)+j.second;}return b;}
  function oracle(prefix,remaining){if(!remaining.length)return makespan(prefix);let best=Infinity;
   for(let i=0;i<remaining.length;i++)best=Math.min(best,oracle([...prefix,remaining[i]],remaining.filter((_,j)=>j!==i)));return best;}
  const got=johnsonTwoMachineSchedule({jobs});assert.equal(got.makespan,oracle([],jobs));
  assert.equal(makespan(got.orderedIds.map(id=>jobs.find(j=>j.id===id))),got.makespan);
 }
});
test('all combinatorial operators reject malformed or oversized inputs',()=>{
 assert.throws(()=>weightedIntervalScheduling({jobs:[{id:'a',start:2,end:1,reward:1}]}),/duration/);
 assert.throws(()=>matrixChainMultiplication({dimensions:[1]}),/at least/);
 assert.throws(()=>minimumCoinChange({amount:5,denominations:[0]}),/integer/);
 assert.throws(()=>exactSubsetSum({target:100000,values:Array(64).fill(1)}),/budget/);
 assert.throws(()=>longestIncreasingSubsequence({values:[NaN]}),/integer/);
 assert.throws(()=>levenshteinDistance({left:1,right:''}),/string/);
 assert.throws(()=>longestCommonSubsequence({left:'a'.repeat(257),right:''}),/256/);
 assert.throws(()=>optimalHuffmanLengths({symbols:[{id:'a',weight:0}]}),/integer/);
 assert.throws(()=>optimalSuccessfulBinarySearchTree({weights:[]}),/nonempty/);
 assert.throws(()=>minimumPalindromePartition({text:4}),/string/);
 assert.throws(()=>johnsonTwoMachineSchedule({jobs:[{id:'a',first:2,second:-1}]}),/integer/);
});
