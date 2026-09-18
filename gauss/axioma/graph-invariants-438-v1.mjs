/* Exhaustively check bounded graph invariants with independent vertex/edge subset and path oracles. */
import {runBatchBank,seq,frac} from './batch-238-common.mjs';
const tags=['GRAPH_DEGREE_SEQUENCE','GRAPH_DEGREE_HIST','GRAPH_ISOLATED','GRAPH_PENDANT','GRAPH_DENSITY_RATIONAL','GRAPH_CONNECTED_K','GRAPH_INDEPENDENT_K','GRAPH_VERTEX_COVER_K','GRAPH_EDGE_COVER_K','GRAPH_MAXIMAL_INDEP','GRAPH_MAXIMAL_CLIQUE','GRAPH_CYCLES_FOUR','GRAPH_INDUCED_CYCLES_FOUR','GRAPH_CLIQUES_FOUR','GRAPH_WEDGES','GRAPH_OPEN_WEDGES','GRAPH_ZAGREB_FIRST','GRAPH_ZAGREB_SECOND','GRAPH_ADJACENCY_MATRIX','GRAPH_INCIDENCE_MATRIX','GRAPH_COMPLEMENT','GRAPH_LINE_GRAPH','GRAPH_SHORTEST_PATH_COUNTS','GRAPH_DISTANCE_SUM','GRAPH_CLOSED_WALKS'];
const value=v=>({value:String(v)}),subsets=a=>seq(2**a.length).map(mask=>a.filter((_,i)=>mask&(1<<i)));
function input(tag,i,r){const n=1+i%5,edges=[];for(let a=0;a<n;a++)for(let b=a+1;b<n;b++)if(i%8===0||i%8!==1&&r(2))edges.push(r(2)?{from:a,to:b}:{from:b,to:a});const x={vertexCount:n,edges};if(['GRAPH_CONNECTED_K','GRAPH_INDEPENDENT_K','GRAPH_VERTEX_COVER_K','GRAPH_EDGE_COVER_K'].includes(tag))x.k=r((tag==='GRAPH_EDGE_COVER_K'?edges.length:n)+1);if(tag==='GRAPH_SHORTEST_PATH_COUNTS')x.source=r(n);if(tag==='GRAPH_CLOSED_WALKS')x.length=i%7;return x;}
function reference(tag,x){const n=x.vertexCount,edges=x.edges.map(e=>[e.from,e.to]),adj=seq(n).map(i=>seq(n).map(j=>Number(edges.some(([u,v])=>u===i&&v===j||u===j&&v===i)))),degrees=adj.map(row=>row.reduce((s,v)=>s+v,0)),verts=seq(n),es=subsets(edges);
 const connected=vs=>{if(!vs.length)return false;const visited=new Set([vs[0]]);for(let k=0;k<vs.length;k++)for(const u of vs)if(!visited.has(u)&&[...visited].some(v=>adj[u][v]))visited.add(u);return visited.size===vs.length;};
 const independent=vs=>vs.every((v,i)=>vs.slice(i+1).every(u=>!adj[v][u]));
 const clique=vs=>vs.every((v,i)=>vs.slice(i+1).every(u=>!!adj[v][u]));
 const vertexCover=vs=>edges.every(([a,b])=>vs.includes(a)||vs.includes(b));
 const all=subsets(verts);
 const bfs=s=>{const d=Array(n).fill(-1),q=[s];d[s]=0;for(let z=0;z<q.length;z++)for(const u of verts)if(adj[q[z]][u]&&d[u]<0){d[u]=d[q[z]]+1;q.push(u);}return d;};
 switch(tag){
 case 'GRAPH_DEGREE_SEQUENCE':return {degrees};
 case 'GRAPH_DEGREE_HIST':return {counts:verts.map(k=>degrees.filter(d=>d===k).length)};
 case 'GRAPH_ISOLATED':return {vertices:verts.filter(v=>degrees[v]===0)};
 case 'GRAPH_PENDANT':return {vertices:verts.filter(v=>degrees[v]===1)};
 case 'GRAPH_DENSITY_RATIONAL':{const [numerator,denominator]=frac(edges.length,n*(n-1)/2||1).split('/');return {numerator,denominator};}
 case 'GRAPH_CONNECTED_K':return value(all.filter(v=>v.length===x.k&&connected(v)).length);
 case 'GRAPH_INDEPENDENT_K':return value(all.filter(v=>v.length===x.k&&independent(v)).length);
 case 'GRAPH_VERTEX_COVER_K':return value(all.filter(v=>v.length===x.k&&vertexCover(v)).length);
 case 'GRAPH_EDGE_COVER_K':return value(es.filter(v=>v.length===x.k&&verts.every(w=>v.some(([a,b])=>a===w||b===w))).length);
 case 'GRAPH_MAXIMAL_INDEP':return value(all.filter(v=>independent(v)&&verts.every(w=>v.includes(w)||!independent([...v,w]))).length);
 case 'GRAPH_MAXIMAL_CLIQUE':return value(all.filter(v=>v.length&&clique(v)&&verts.every(w=>v.includes(w)||!clique([...v,w]))).length);
 case 'GRAPH_CYCLES_FOUR':{let count=0;for(const a of verts)for(const b of verts)for(const c of verts)for(const d of verts)if(new Set([a,b,c,d]).size===4&&adj[a][b]&&adj[b][c]&&adj[c][d]&&adj[d][a])count++;return value(count/8);}
 case 'GRAPH_INDUCED_CYCLES_FOUR':return value(all.filter(v=>v.length===4&&v.every(w=>v.reduce((s,u)=>s+adj[w][u],0)===2)).length);
 case 'GRAPH_CLIQUES_FOUR':return value(all.filter(v=>v.length===4&&clique(v)).length);
 case 'GRAPH_WEDGES':return value(verts.reduce((s,v)=>s+all.filter(w=>w.length===2&&w.every(u=>adj[v][u])).length,0));
 case 'GRAPH_OPEN_WEDGES':return value(verts.reduce((s,v)=>s+all.filter(w=>w.length===2&&w.every(u=>adj[v][u])&&!adj[w[0]][w[1]]).length,0));
 case 'GRAPH_ZAGREB_FIRST':return value(degrees.reduce((s,v)=>s+v*v,0));
 case 'GRAPH_ZAGREB_SECOND':return value(edges.reduce((s,[a,b])=>s+degrees[a]*degrees[b],0));
 case 'GRAPH_ADJACENCY_MATRIX':return {matrix:adj};
 case 'GRAPH_INCIDENCE_MATRIX':return {matrix:verts.map(v=>edges.map(([a,b])=>v===Math.min(a,b)?-1:v===Math.max(a,b)?1:0))};
 case 'GRAPH_COMPLEMENT':return {edges:verts.flatMap(i=>verts.filter(j=>i<j&&!adj[i][j]).map(to=>({from:i,to})))};
 case 'GRAPH_LINE_GRAPH':return {vertexCount:edges.length,edges:edges.flatMap((a,i)=>edges.slice(i+1).flatMap((b,k)=>a.some(v=>b.includes(v))?[{from:i,to:i+k+1}]:[]))};
 case 'GRAPH_SHORTEST_PATH_COUNTS':{const distances=bfs(x.source),pathCounts=verts.map(target=>{if(distances[target]<0)return '0';let ways=0;function walk(v,seen){if(v===target){if(seen.length-1===distances[target])ways++;return;}for(const u of verts)if(adj[v][u]&&!seen.includes(u)&&seen.length<=distances[target])walk(u,[...seen,u]);}walk(x.source,[x.source]);return String(ways);});return {distances,pathCounts};}
 case 'GRAPH_DISTANCE_SUM':{const distances=verts.map(bfs);if(distances.some(a=>a.includes(-1)))return {connected:false,value:null};return {connected:true,value:String(verts.reduce((s,v)=>s+distances[v].slice(v+1).reduce((t,d)=>t+d,0),0))};}
 case 'GRAPH_CLOSED_WALKS':{let count=0;function walk(start,at,steps){if(steps===0){if(at===start)count++;return;}for(const u of verts)if(adj[at][u])walk(start,u,steps-1);}for(const v of verts)walk(v,v,x.length);return value(count);}
 default:throw Error('missing graph reference '+tag);
 }
}
export const runGraphInvariant438Bank=options=>runBatchBank({name:'AXIOMA graph invariants independent subsets 301–325',prefix:'CS',start:301,tags,input,reference,...options});
