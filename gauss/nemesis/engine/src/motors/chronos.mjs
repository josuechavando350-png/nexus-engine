import { object, array, id, integer, unique } from './shared.mjs';

/** Clock offsets x[to]-x[from] in [min,max], solved as difference constraints. */
export function synchronizeClockIntervals(input) {
  object(input,'clock network',['clocks','anchor','constraints']);
  const clocks=unique(array(input.clocks,'clocks',1,64).map((c,i)=>id(c,`clocks[${i}]`)),'clocks');
  const anchor=id(input.anchor,'anchor'); if(!clocks.includes(anchor)) throw new TypeError('anchor unknown');
  const indexes=new Map(clocks.map((c,i)=>[c,i]));
  const constraints=array(input.constraints,'constraints',0,512).map((c,i)=>{
    object(c,`constraints[${i}]`,['id','from','to','min','max']);
    id(c.id,`constraints[${i}].id`); id(c.from,`constraints[${i}].from`);id(c.to,`constraints[${i}].to`);
    if(!indexes.has(c.from)||!indexes.has(c.to)) throw new TypeError('constraint references unknown clock');
    const min=integer(c.min,`constraints[${i}].min`,-100000000,100000000);
    const max=integer(c.max,`constraints[${i}].max`,-100000000,100000000);
    if(min>max) throw new TypeError('constraint min exceeds max');
    return {...c,min,max};
  });
  unique(constraints.map(c=>c.id),'constraint ids');
  const edges=constraints.flatMap(c=>[
    {u:indexes.get(c.from),v:indexes.get(c.to),w:c.max,source:c.id},
    {u:indexes.get(c.to),v:indexes.get(c.from),w:-c.min,source:c.id}
  ]);
  const n=clocks.length;
  // Super-source shortest paths detect any infeasible negative cycle, including outside anchor's component.
  const d=Array(n).fill(0),prev=Array(n).fill(null); let changed=-1;
  for(let iteration=0;iteration<n;iteration++) {
    changed=-1;
    for(const edge of edges) if(d[edge.v]>d[edge.u]+edge.w){
      d[edge.v]=d[edge.u]+edge.w;prev[edge.v]=edge;changed=edge.v;
    }
    if(changed===-1) break;
  }
  if(changed!==-1) {
    let x=changed;for(let i=0;i<n;i++) x=prev[x].u;
    const cycle=[], start=x; do { const e=prev[x];cycle.push({constraintId:e.source,from:clocks[e.u],to:clocks[e.v],bound:e.w}); x=e.u; } while(x!==start && cycle.length<=n+1);
    return {engine:'NEMESIS_CLOCK_DIFFERENCE_CONSTRAINTS_V1',status:'INCONSISTENT',negativeCycle:cycle.reverse(),note:'Infeasible offset constraints; no synchronized assignment asserted.'};
  }
  // Anchoring must connect every clock, otherwise absolute intervals cannot be claimed.
  const origin=indexes.get(anchor);
  function shortest(start,reverse=false){
    const dist=Array(n).fill(Infinity);dist[start]=0;
    for(let iteration=0;iteration<n-1;iteration++) {
      let update=false;
      for(const e of edges) {const u=reverse?e.v:e.u,v=reverse?e.u:e.v;
        if(dist[u]!==Infinity && dist[v]>dist[u]+e.w){dist[v]=dist[u]+e.w;update=true;}
      }
      if(!update) break;
    }
    return dist;
  }
  const upper=shortest(origin), toAnchor=shortest(origin,true);
  if(upper.some(x=>x===Infinity)) throw new TypeError('every clock must be constrained to anchor (network disconnected)');
  const assignment=upper.map(x=>x-upper[origin]);
  if(constraints.some(c=> {const delta=assignment[indexes.get(c.to)]-assignment[indexes.get(c.from)];return delta<c.min||delta>c.max;})) throw new Error('internal assignment violates constraint');
  return {engine:'NEMESIS_CLOCK_DIFFERENCE_CONSTRAINTS_V1',status:'PASS',anchor,
    offsets:clocks.map((clock,i)=>({clock,minimum:toAnchor[i]===0?0:-toAnchor[i],maximum:upper[i],feasibleAssignment:assignment[i]})),
    constraintCount:constraints.length,
    note:'Integer static offset feasibility only; no NTP exchange, drift, Byzantine peers or physical synchronization.'};
}
