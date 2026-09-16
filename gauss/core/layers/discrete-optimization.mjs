// NEXUS-owned bounded combinatorial algorithms. Each solves a different decision
// problem, returns a checkable witness, and refuses inputs beyond its exact scope.
const seal = Object.freeze;
function integer(x,label,min,max){if(!Number.isSafeInteger(x)||x<min||x>max)throw new TypeError(`${label} must be an integer in [${min},${max}]`);return x;}
function list(a,label,max){if(!Array.isArray(a)||a.length>max)throw new TypeError(`${label} must be an array of at most ${max}`);return a;}
function uniqueStrings(xs,label,max){list(xs,label,max);const ids=xs.map((x,i)=>{if(typeof x!=='string'||!x||x.length>64)throw new TypeError(`${label}[${i}] invalid id`);return x;});if(new Set(ids).size!==ids.length)throw new TypeError(`${label} duplicate id`);return ids;}
function checkFinite(value,label){if(!Number.isSafeInteger(value))throw new RangeError(`${label} overflow beyond safe integers`);return value;}

export function weightedIntervalScheduling({jobs}){
  const rows=list(jobs,'jobs',128).map((j,i)=>{
    if(!j||typeof j!=='object')throw new TypeError('job must be object');
    return {id:j.id,start:integer(j.start,`jobs[${i}].start`,0,1000000),end:integer(j.end,`jobs[${i}].end`,0,1000000),reward:integer(j.reward,`jobs[${i}].reward`,0,1000000)};
  });
  uniqueStrings(rows.map(r=>r.id),'job ids',128);
  if(rows.some(r=>r.end<=r.start))throw new TypeError('jobs require strictly positive duration');
  rows.sort((a,b)=>a.end-b.end||a.start-b.start||a.id.localeCompare(b.id));
  const n=rows.length,dp=Array(n+1).fill(0),take=Array(n+1).fill(false),pred=Array(n+1).fill(0);
  for(let i=1;i<=n;i++){
    let lo=0,hi=i-1;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(rows[mid-1]?.end<=rows[i-1].start)lo=mid;else hi=mid-1;}
    pred[i]=lo;
    const including=rows[i-1].reward+dp[lo];checkFinite(including,'interval reward');
    if(including>dp[i-1]){dp[i]=including;take[i]=true;}else dp[i]=dp[i-1];
  }
  const selected=[];for(let i=n;i>0;)if(take[i]){selected.push(rows[i-1].id);i=pred[i];}else i--;
  selected.reverse();return seal({optimalReward:dp[n],selectedIds:seal(selected)});
}

export function matrixChainMultiplication({dimensions}){
 const d=list(dimensions,'dimensions',17).map((x,i)=>integer(x,`dimensions[${i}]`,1,1000));
 if(d.length<2)throw new TypeError('at least one matrix required');
 const n=d.length-1,dp=Array.from({length:n},()=>Array(n).fill(0)),split=Array.from({length:n},()=>Array(n).fill(-1));
 for(let len=2;len<=n;len++)for(let i=0;i+len<=n;i++){
  const j=i+len-1;let best=Infinity,kBest=-1;
  for(let k=i;k<j;k++){const cost=dp[i][k]+dp[k+1][j]+d[i]*d[k+1]*d[j+1];checkFinite(cost,'matrix-chain operations');if(cost<best){best=cost;kBest=k;}}
  dp[i][j]=best;split[i][j]=kBest;
 }
 function expression(i,j){if(i===j)return `A${i}`;const k=split[i][j];return `(${expression(i,k)}×${expression(k+1,j)})`;}
 return seal({scalarMultiplications:dp[0][n-1],parenthesization:expression(0,n-1)});
}

export function minimumCoinChange({amount,denominations}){
 const total=integer(amount,'amount',0,100000),coins=list(denominations,'denominations',128).map((x,i)=>integer(x,`denominations[${i}]`,1,100000));
 if(new Set(coins).size!==coins.length)throw new TypeError('duplicate denominations');
 const dp=Array(total+1).fill(Infinity),choice=Array(total+1).fill(-1);dp[0]=0;
 for(let v=1;v<=total;v++)for(const c of coins)if(c<=v && dp[v-c]+1<dp[v]){dp[v]=dp[v-c]+1;choice[v]=c;}
 if(!Number.isFinite(dp[total]))return seal({reachable:false,minimumCoins:null,coins:seal([])});
 const selected=[];for(let v=total;v>0;v-=choice[v])selected.push(choice[v]);
 selected.sort((a,b)=>a-b);return seal({reachable:true,minimumCoins:dp[total],coins:seal(selected)});
}

export function exactSubsetSum({target,values}){
 const goal=integer(target,'target',0,100000),v=list(values,'values',64).map((x,i)=>integer(x,`values[${i}]`,0,100000));
 if(v.length*goal>2000000)throw new RangeError('subset-sum state budget exceeded');
 const reachable=new Uint8Array(goal+1),parent=Array(goal+1).fill(null);reachable[0]=1;
 for(let i=0;i<v.length;i++)for(let s=goal;s>=v[i];s--)if(!reachable[s]&&reachable[s-v[i]]){
  reachable[s]=1;parent[s]={index:i,previous:s-v[i]};
 }
 if(!reachable[goal])return seal({reachable:false,selectedIndices:seal([])});
 const indices=[];for(let s=goal;s>0;){const p=parent[s];indices.push(p.index);s=p.previous;}
 indices.reverse();return seal({reachable:true,selectedIndices:seal(indices)});
}

export function longestIncreasingSubsequence({values}){
 const a=list(values,'values',10000).map((v,i)=>integer(v,`values[${i}]`,-1000000,1000000));
 const tails=[],tailIndices=[],previous=Array(a.length).fill(-1);
 for(let i=0;i<a.length;i++){
  let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>1;if(tails[mid]<a[i])lo=mid+1;else hi=mid;}
  if(lo>0)previous[i]=tailIndices[lo-1];tails[lo]=a[i];tailIndices[lo]=i;
 }
 let at=tailIndices.at(-1),indices=[];while(at!==undefined&&at!==-1){indices.push(at);at=previous[at];}
 indices.reverse();return seal({length:indices.length,indices:seal(indices),subsequence:seal(indices.map(i=>a[i]))});
}

function characters(value,label){if(typeof value!=='string')throw new TypeError(`${label} must be a string`);const chars=[...value];if(chars.length>256)throw new RangeError(`${label} must have at most 256 Unicode code points`);return chars;}
export function levenshteinDistance({left,right}){
 const a=characters(left,'left'),b=characters(right,'right');let prev=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const cur=[i];for(let j=1;j<=b.length;j++)cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}
 return seal({distance:prev[b.length]});
}
export function longestCommonSubsequence({left,right}){
 const a=characters(left,'left'),b=characters(right,'right'),dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
 let i=0,j=0,s='';while(i<a.length&&j<b.length)if(a[i]===b[j]){s+=a[i];i++;j++;}else if(dp[i+1][j]>=dp[i][j+1])i++;else j++;
 return seal({length:dp[0][0],subsequence:s});
}

export function optimalHuffmanLengths({symbols}){
 const rows=list(symbols,'symbols',128).map((s,i)=>{
  if(!s||typeof s!=='object')throw new TypeError('symbol must be object');
  return {id:s.id,weight:integer(s.weight,`symbols[${i}].weight`,1,1000000)};
 });
 uniqueStrings(rows.map(r=>r.id),'symbol ids',128);if(!rows.length)throw new TypeError('at least one symbol required');
 let queue=rows.map((r,i)=>({weight:r.weight,minId:r.id,left:null,right:null,id:r.id}));
 let weightedPathLength=0;
 if(queue.length===1)return seal({weightedPathLength:0,codeLengths:seal([{id:queue[0].id,length:0}])});
 while(queue.length>1){queue.sort((a,b)=>a.weight-b.weight||a.minId.localeCompare(b.minId));const x=queue.shift(),y=queue.shift();
  const weight=checkFinite(x.weight+y.weight,'Huffman merged weight');weightedPathLength=checkFinite(weightedPathLength+weight,'Huffman objective');
  queue.push({weight,minId:x.minId<y.minId?x.minId:y.minId,left:x,right:y,id:null});
 }
 const lengths=[];function visit(node,depth){if(node.id!==null){lengths.push({id:node.id,length:depth});return;}visit(node.left,depth+1);visit(node.right,depth+1);}
 visit(queue[0],0);lengths.sort((a,b)=>a.id.localeCompare(b.id));
 return seal({weightedPathLength,codeLengths:seal(lengths.map(seal))});
}

export function optimalSuccessfulBinarySearchTree({weights}){
 const w=list(weights,'weights',16).map((x,i)=>integer(x,`weights[${i}]`,0,1000000));
 if(!w.length)throw new TypeError('nonempty weights required');
 const n=w.length,sum=Array(n+1).fill(0);for(let i=0;i<n;i++)sum[i+1]=sum[i]+w[i];
 const dp=Array.from({length:n},()=>Array(n).fill(0)),root=Array.from({length:n},()=>Array(n).fill(-1));
 for(let span=1;span<=n;span++)for(let i=0;i+span<=n;i++){
  const j=i+span-1,intervalWeight=sum[j+1]-sum[i];let best=Infinity;
  for(let k=i;k<=j;k++){const cost=intervalWeight+(k>i?dp[i][k-1]:0)+(k<j?dp[k+1][j]:0);
   if(cost<best){best=cost;root[i][j]=k;}}
  dp[i][j]=checkFinite(best,'optimal BST cost');
 }
 const nodes=[];function emit(i,j,parent){if(i>j)return;const k=root[i][j];nodes.push({key:k,parent});emit(i,k-1,k);emit(k+1,j,k);}
 emit(0,n-1,-1);nodes.sort((a,b)=>a.key-b.key);
 return seal({weightedSearchCost:dp[0][n-1],nodes:seal(nodes.map(seal))});
}

export function minimumPalindromePartition({text}){
 const a=characters(text,'text'),n=a.length,pal=Array.from({length:n},()=>Array(n).fill(false)),dp=Array(n+1).fill(Infinity),next=Array(n).fill(-1);dp[n]=0;
 for(let i=n-1;i>=0;i--)for(let j=i;j<n;j++)if(a[i]===a[j]&&(j-i<2||pal[i+1][j-1])){
  pal[i][j]=true;if(1+dp[j+1]<dp[i]){dp[i]=1+dp[j+1];next[i]=j+1;}
 }
 const parts=[];for(let i=0;i<n;i=next[i])parts.push(a.slice(i,next[i]).join(''));
 return seal({minimumParts:dp[0],parts:seal(parts)});
}

export function johnsonTwoMachineSchedule({jobs}){
 const rows=list(jobs,'jobs',128).map((job,i)=>{
  if(!job||typeof job!=='object')throw new TypeError('job must be object');
  return {id:job.id,first:integer(job.first,`jobs[${i}].first`,0,1000000),second:integer(job.second,`jobs[${i}].second`,0,1000000)};
 });
 uniqueStrings(rows.map(j=>j.id),'job ids',128);
 const front=rows.filter(j=>j.first<=j.second).sort((a,b)=>a.first-b.first||a.id.localeCompare(b.id));
 const back=rows.filter(j=>j.first>j.second).sort((a,b)=>b.second-a.second||a.id.localeCompare(b.id));
 const order=[...front,...back];let firstEnd=0,secondEnd=0;
 for(const job of order){firstEnd=checkFinite(firstEnd+job.first,'two-machine horizon');secondEnd=checkFinite(Math.max(firstEnd,secondEnd)+job.second,'two-machine horizon');}
 return seal({makespan:secondEnd,orderedIds:seal(order.map(j=>j.id))});
}
