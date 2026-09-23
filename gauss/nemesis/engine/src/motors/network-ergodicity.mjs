import {object,array,number,integer,prob} from './finite-tools.mjs';
/** Exact graph classification of a supplied finite homogeneous Markov chain. */
export function analyzeNetworkErgodicity(input){
 object(input,'ergodicity',['transition','steps'],['transition']); const P=array(input.transition,'transition',1,128),n=P.length;
 P.forEach((r,i)=>prob(r,`transition[${i}]`,n));
 const adj=P.map(row=>row.flatMap((v,j)=>v>0?[j]:[]));
 const reach=Array.from({length:n},(_,s)=>{const seen=new Set([s]),stack=[s];for(const u of stack)for(const v of adj[u])if(!seen.has(v)){seen.add(v);stack.push(v);}return seen;});
 const comps=[];const assigned=new Set();for(let i=0;i<n;i++)if(!assigned.has(i)){const part=[...reach[i]].filter(j=>reach[j].has(i)).sort((a,b)=>a-b);part.forEach(j=>assigned.add(j));comps.push(part);}
 const closed=comps.filter(c=>c.every(u=>adj[u].every(v=>c.includes(v))));
 function period(c){const cset=new Set(c),depth=new Map([[c[0],0]]),q=[c[0]];for(const u of q)for(const v of adj[u])if(cset.has(v)&&!depth.has(v)){depth.set(v,depth.get(u)+1);q.push(v);}
  let g=0;const gcd=(a,b)=>b?gcd(b,a%b):Math.abs(a);for(const u of c)for(const v of adj[u])if(cset.has(v))g=gcd(g,depth.get(u)+1-depth.get(v));return g;}
 const recurrent=closed.map(states=>({states,period:period(states)}));const irreducible=comps.length===1,aperiodic=irreducible&&recurrent[0].period===1;
 const steps=integer(input.steps??2000,'steps',1,100000);let pi=Array(n).fill(1/n);const avg=Array(n).fill(0);
 // Cesaro averages converge for finite irreducible chains even if periodic.
 for(let t=0;t<steps;t++){pi=Array.from({length:n},(_,j)=>pi.reduce((s,x,i)=>s+x*P[i][j],0));pi.forEach((x,i)=>avg[i]+=x/steps);}
 return {domain:'FINITE_MARKOV_CHAIN',stateCount:n,communicatingClasses:comps,recurrentClasses:recurrent,irreducible,aperiodic,ergodic:irreducible&&aperiodic,cesaroEstimate:avg,steps,note:'Graph-theoretic ergodicity is proved only for the supplied finite transition matrix; Cesaro distribution is a numerical estimate.'};
}
