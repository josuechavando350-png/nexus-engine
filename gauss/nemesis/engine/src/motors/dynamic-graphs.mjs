import {object,array,id,integer,unique} from './shared.mjs';
/** Mutating an in-memory graph snapshot with deterministic BFS and graph statistics. */
export function analyzeDynamicGraph(input){
 object(input,'graph',['vertices','edges','updates','source'],['vertices','edges','updates']);
 const vertices=unique(array(input.vertices,'vertices',1,10000).map((v,i)=>id(v,`vertex${i}`)),'vertices'),vset=new Set(vertices);
 const key=(a,b)=>a<b?`${a}\0${b}`:`${b}\0${a}`;
 const edges=new Map();const readEdge=(edge,name)=>{object(edge,name,['from','to']);id(edge.from,'from');id(edge.to,'to');if(!vset.has(edge.from)||!vset.has(edge.to)||edge.from===edge.to)throw new TypeError('unknown vertex or self-loop');return key(edge.from,edge.to);};
 for(const e of array(input.edges,'edges',0,100000)){const k=readEdge(e,'edge');if(edges.has(k))throw new TypeError('duplicate edge');edges.set(k,e);}
 const updates=[];
 for(const u of array(input.updates,'updates',0,10000)){
  object(u,'update',['kind','from','to']);if(!['add','remove'].includes(u.kind))throw new TypeError('unknown update');
  const k=readEdge({from:u.from,to:u.to},'update');if((u.kind==='add')===edges.has(k))throw new TypeError('duplicate add or missing removal');
  if(u.kind==='add')edges.set(k,{from:u.from,to:u.to});else edges.delete(k);updates.push({kind:u.kind,edge:k.replace('\0','--')});
 }
 const adj=new Map(vertices.map(v=>[v,[]]));for(const e of edges.values()){adj.get(e.from).push(e.to);adj.get(e.to).push(e.from);}
 for(const neighbors of adj.values())neighbors.sort();
 const seen=new Set(),components=[];for(const v of vertices){if(seen.has(v))continue;const q=[v];seen.add(v);for(let i=0;i<q.length;i++)for(const w of adj.get(q[i]))if(!seen.has(w)){seen.add(w);q.push(w);}components.push(q.sort());}
 let shortestPaths=null;if(input.source!==undefined){if(!vset.has(input.source))throw new TypeError('source unknown');const q=[input.source],dist=Object.fromEntries(vertices.map(v=>[v,null]));dist[input.source]=0;for(let i=0;i<q.length;i++)for(const w of adj.get(q[i]))if(dist[w]===null){dist[w]=dist[q[i]]+1;q.push(w);}shortestPaths=dist;}
 return {domain:'IN_MEMORY_DYNAMIC_UNDIRECTED_GRAPH',vertexCount:vertices.length,edgeCount:edges.size,components,degrees:Object.fromEntries(vertices.map(v=>[v,adj.get(v).length])),shortestPaths,updates,note:'Graph updates and full BFS recomputation in memory; not a distributed graph database or guaranteed sublinear dynamic algorithm.'};
}
