import assert from 'node:assert/strict';
import {graphFourCycleCount,graphInducedFourCycleCount,graphShortestPathCounts,graphDistanceSum} from '../core/layers/batch-400-graphs.mjs';
import {permutationRank,permutationUnrank,nextPermutation,previousPermutation,permutationPower,inversePermutation} from '../core/layers/batch-600-permutations.mjs';
import {markovStateDistribution,markovHitByHorizon,markovExactVisits,markovOccupancy} from '../core/layers/batch-1000-markov.mjs';
import {fpProduct,fpResultant,fpRoots,fpDerivative} from '../core/layers/batch-800-finite-polynomials.mjs';
let seed=0x17c9a43d;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};const N=n=>rnd()%n;
const gcd=(a,b)=>b?gcd(b,a%b):a<0n?-a:a;
const Q=(a,b=1n)=>{a=BigInt(a);b=BigInt(b);if(!b)throw Error('zero denom');if(b<0n){a=-a;b=-b;}const g=gcd(a,b);return [a/g,b/g];};
const add=(a,b)=>Q(a[0]*b[1]+b[0]*a[1],a[1]*b[1]);
const mul=(a,b)=>Q(a[0]*b[0],a[1]*b[1]);
const asQ=s=>s.includes('/')?s.split('/').map(BigInt):[BigInt(s),1n];
const eq=(a,b)=>assert.deepEqual(a,b);
let checks={graph:0,permutation:0,markov:0,polynomial:0};
for(let z=0;z<300;z++){
 const n=1+N(6),edges=[],adj=Array.from({length:n},()=>Array(n).fill(0));for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(N(2)){edges.push({from:i,to:j});adj[i][j]=adj[j][i]=1;}
 const x={vertexCount:n,edges};let cycles=0,induced=0;
 for(let a=0;a<n;a++)for(let b=a+1;b<n;b++)for(let c=b+1;c<n;c++)for(let d=c+1;d<n;d++){
  const vs=[a,b,c,d],es=[];for(let k=0;k<4;k++)for(let j=k+1;j<4;j++)if(adj[vs[k]][vs[j]])es.push([k,j]);
  const deg=vs.map(v=>vs.reduce((v0,u)=>v0+adj[v][u],0));
  if(deg.every(t=>t===2)){cycles++;induced++;}
  if(es.length===5){cycles++;}
  if(es.length===6){cycles+=3;}
 }
 eq(graphFourCycleCount(x).value,String(cycles));checks.graph++;
 eq(graphInducedFourCycleCount(x).value,String(induced));checks.graph++;
 const s=N(n),q=[s],dist=Array(n).fill(-1),ways=Array(n).fill(0n);dist[s]=0;ways[s]=1n;
 while(q.length){let v=q.shift();for(let t=0;t<n;t++)if(adj[v][t]){if(dist[t]===-1){dist[t]=dist[v]+1;q.push(t);}if(dist[t]===dist[v]+1)ways[t]+=ways[v];}}
 eq(graphShortestPathCounts({...x,source:s}),{distances:dist,pathCounts:ways.map(String)});checks.graph++;
 const disconnected=dist.some(t=>t<0);if(disconnected){eq(graphDistanceSum(x),{connected:false,value:null});}else{
 let total=0;for(let i=0;i<n;i++){const seen=new Set([i]),qq=[[i,0]];while(qq.length){const[v,d]=qq.shift();total+=d;for(let j=0;j<n;j++)if(adj[v][j]&&!seen.has(j)){seen.add(j);qq.push([j,d+1]);}}}eq(graphDistanceSum(x),{connected:true,value:String(total/2)});
 }checks.graph++;
}
const fact=n=>Array.from({length:n},(_,i)=>BigInt(i+1)).reduce((a,b)=>a*b,1n);
const ranks=a=>{let rank=0n;for(let i=0;i<a.length;i++){let less=0;for(let j=i+1;j<a.length;j++)if(a[j]<a[i])less++;rank+=BigInt(less)*fact(a.length-i-1);}return rank;};
for(let z=0;z<500;z++){
 const n=1+N(8),a=Array.from({length:n},(_,i)=>i);for(let i=n-1;i>0;i--){const j=N(i+1);[a[i],a[j]]=[a[j],a[i]];}
 const r=ranks(a), x={permutation:a};eq(permutationRank(x).rank,String(r));checks.permutation++;
 eq(permutationUnrank({size:n,rank:String(r)}).permutation,a);checks.permutation++;
 const nxt=nextPermutation(x).permutation,prev=previousPermutation(x).permutation;
 if(nxt){eq(ranks(nxt),r+1n);eq(previousPermutation({permutation:nxt}).permutation,a);}else eq(r,fact(n)-1n);checks.permutation++;
 if(prev){eq(ranks(prev),r-1n);eq(nextPermutation({permutation:prev}).permutation,a);}else eq(r,0n);checks.permutation++;
 const inv=inversePermutation(x).permutation,ident=a.map((_,i)=>a[inv[i]]);eq(ident,Array.from({length:n},(_,i)=>i));checks.permutation++;
 eq(permutationPower({...x,exponent:-1}).permutation,inv);checks.permutation++;
}
for(let z=0;z<140;z++){
 const n=1+N(4),weights=Array.from({length:n},()=>Array.from({length:n},()=>N(4)));
 for(const row of weights)if(row.every(v=>v===0))row[N(n)]=1;
 const p=weights.map(row=>row.map(v=>Q(v,row.reduce((a,b)=>a+b,0))));
 const s=N(n),t=N(6),target=N(n),x={weights,start:s,steps:t};
 let active=Array.from({length:n},(_,i)=>Q(i===s?1:0)),occupancy=active.map(v=>v);
 for(let k=0;k<t;k++){const next=Array.from({length:n},()=>Q(0));for(let i=0;i<n;i++)for(let j=0;j<n;j++)next[j]=add(next[j],mul(active[i],p[i][j]));active=next;occupancy=occupancy.map((v,i)=>add(v,active[i]));}
 const actual=markovStateDistribution(x).distribution.map(asQ);eq(actual,active);checks.markov++;
 eq(markovOccupancy(x).expectedVisits.map(asQ),occupancy);checks.markov++;
 let hit=Q(s===target?1:0),not=Array.from({length:n},(_,i)=>Q(i===s&&s!==target?1:0));for(let k=0;k<t;k++){
  const next=Array.from({length:n},()=>Q(0));for(let i=0;i<n;i++)for(let j=0;j<n;j++)next[j]=add(next[j],mul(not[i],p[i][j]));hit=add(hit,next[target]);next[target]=Q(0);not=next;
 }
 eq(asQ(markovHitByHorizon({...x,target}).probability),hit);checks.markov++;
 const visits=N(t+3);let visitsDP=Array.from({length:n},()=>Array.from({length:t+2},()=>Q(0)));visitsDP[s][s===target?1:0]=Q(1);
 for(let k=0;k<t;k++){const next=Array.from({length:n},()=>Array.from({length:t+2},()=>Q(0)));for(let i=0;i<n;i++)for(let c=0;c<=t;c++)for(let j=0;j<n;j++){const nc=c+(j===target?1:0);next[j][nc]=add(next[j][nc],mul(visitsDP[i][c],p[i][j]));}visitsDP=next;}
 const prob=visitsDP.reduce((v,r)=>add(v,r[visits]??Q(0)),Q(0));eq(asQ(markovExactVisits({...x,target,visits}).probability),prob);checks.markov++;
}
const mod=(a,p)=>((a%p)+p)%p;
const evalP=(a,x,p)=>a.reduceRight((v,c)=>mod(v*x+c,p),0);
const determinant=(m,p)=>{const n=m.length,used=Array(n).fill(false);let sum=0;function walk(i,prod,sign){if(i===n){sum=mod(sum+sign*prod,p);return;}for(let j=0;j<n;j++)if(!used[j]){let s=sign;for(let k=j+1;k<n;k++)if(used[k])s=-s;used[j]=true;walk(i+1,mod(prod*m[i][j],p),s);used[j]=false;}}walk(0,1,1);return sum;};
for(let z=0;z<200;z++){
 const p=[2,3,5,7][N(4)],m=1+N(4),n=1+N(4),a=Array.from({length:m+1},()=>N(p)),b=Array.from({length:n+1},()=>N(p));if(!a[m])a[m]=1;if(!b[n])b[n]=1;
 const x={prime:p,left:a,right:b};const conv=Array(m+n+1).fill(0);for(let i=0;i<=m;i++)for(let j=0;j<=n;j++)conv[i+j]=mod(conv[i+j]+a[i]*b[j],p);
 eq(fpProduct(x).coefficients,conv.slice(0,conv.length>1?conv.findLastIndex(v=>v!==0)+1:1));checks.polynomial++;
 const mat=[];for(let k=0;k<n;k++){const r=Array(m+n).fill(0);for(let i=0;i<=m;i++)r[k+i]=a[m-i];mat.push(r);}for(let k=0;k<m;k++){const r=Array(m+n).fill(0);for(let i=0;i<=n;i++)r[k+i]=b[n-i];mat.push(r);}
 eq(fpResultant(x).value,determinant(mat,p));checks.polynomial++;
 const deriv=a.slice(1).map((v,i)=>mod(v*(i+1),p));eq(fpDerivative({prime:p,coefficients:a}).coefficients,deriv.slice(0,deriv.findLastIndex(v=>v!==0)+1).length?deriv.slice(0,deriv.findLastIndex(v=>v!==0)+1):[0]);checks.polynomial++;
 eq(fpRoots({prime:p,coefficients:a}).roots,Array.from({length:p},(_,i)=>i).filter(i=>evalP(a,i,p)===0));checks.polynomial++;
}
console.log(JSON.stringify({status:'PASS',seed:'0x17c9a43d',checks,total:Object.values(checks).reduce((a,b)=>a+b,0)}));
