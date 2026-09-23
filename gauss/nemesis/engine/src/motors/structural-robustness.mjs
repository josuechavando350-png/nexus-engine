import { object, array, id, integer, unique } from './shared.mjs';

/** Exact failure robustness of a supplied simple, undirected graph (not physical reliability). */
export function calculateStructuralRobustness(input) {
  object(input, 'graph', ['vertices', 'edges', 'terminals'], ['vertices', 'edges']);
  const vertices = unique(array(input.vertices, 'vertices', 1, 12).map((v, i) => id(v, `vertices[${i}]`)), 'vertices');
  const names = new Map(vertices.map((v, i) => [v, i]));
  const edges = array(input.edges, 'edges', 0, 66).map((edge, i) => {
    object(edge, `edges[${i}]`, ['from', 'to']);
    if (!names.has(edge.from) || !names.has(edge.to) || edge.from === edge.to) throw new TypeError('edges must join distinct known vertices');
    return [Math.min(names.get(edge.from), names.get(edge.to)), Math.max(names.get(edge.from), names.get(edge.to))];
  });
  if (new Set(edges.map(([a,b])=>`${a}:${b}`)).size !== edges.length) throw new TypeError('duplicate undirected edge');
  if (edges.length > 66) throw new TypeError('too many edges');
  let terminals;
  if (input.terminals !== undefined) {
    terminals = array(input.terminals, 'terminals', 2, 2).map((v,i)=>id(v,`terminals[${i}]`));
    if (!names.has(terminals[0]) || !names.has(terminals[1]) || terminals[0] === terminals[1]) throw new TypeError('terminals must be distinct vertices');
  }
  const n = vertices.length;
  function components(removedVertex=-1, removedEdge=-1) {
    const seen = new Set(); const groups = [];
    for (let start=0; start<n; start++) {
      if (start === removedVertex || seen.has(start)) continue;
      const stack=[start], group=[]; seen.add(start);
      while (stack.length) {
        const x=stack.pop(); group.push(vertices[x]);
        for (let i=0;i<edges.length;i++) {
          if (i===removedEdge) continue;
          const [a,b]=edges[i];const next=x===a?b:x===b?a:-1;
          if(next>=0 && next!==removedVertex && !seen.has(next)){seen.add(next);stack.push(next);}
        }
      }
      groups.push(group.sort());
    }
    return groups.sort((a,b)=>vertices.indexOf(a[0])-vertices.indexOf(b[0]));
  }
  const initial=components();
  const articulationPoints=[];
  for(let i=0;i<n;i++) if(components(i).length>initial.length) articulationPoints.push(vertices[i]);
  const bridges=[];
  for(let i=0;i<edges.length;i++) if(components(-1,i).length>initial.length) bridges.push({from:vertices[edges[i][0]],to:vertices[edges[i][1]]});
  let terminalEdgeCut=null, terminalVertexCut=null;
  if(terminals) {
    const [s,t]=terminals.map(v=>names.get(v));
    const connected=(removedVertices,removedEdges)=>{
      const seen=new Set([s]), queue=[s];
      for(let k=0;k<queue.length;k++)for(let e=0;e<edges.length;e++){
        if(removedEdges.has(e))continue;
        const [a,b]=edges[e],x=queue[k],other=x===a?b:x===b?a:-1;
        if(other>=0&&!removedVertices.has(other)&&!seen.has(other)){seen.add(other);queue.push(other);}
      }
      return seen.has(t);
    };
    if(!connected(new Set(),new Set())) {
      terminalEdgeCut={size:0,edges:[]};terminalVertexCut={size:0,vertices:[]};
    } else {
      // Exact s-t edge cut via all vertex bipartitions, not 2^|E| subsets.
      let best=[];
      const candidates=Array.from({length:n},(_,i)=>i).filter(i=>i!==s&&i!==t);
      for(let mask=0;mask<(1<<candidates.length);mask++){
        const side=new Set([s]);candidates.forEach((v,i)=>{if(mask&(1<<i))side.add(v);});
        const cut=edges.map(([a,b],i)=>side.has(a)!==side.has(b)?i:-1).filter(i=>i>=0);
        if(!best.length||cut.length<best.length)best=cut;
      }
      terminalEdgeCut={size:best.length,edges:best.map(i=>({from:vertices[edges[i][0]],to:vertices[edges[i][1]]}))};
      // Minimum internal vertex separator. Adjacent terminals have no internal separator.
      const directlyAdjacent=edges.some(([a,b])=>a===Math.min(s,t)&&b===Math.max(s,t));
      if(!directlyAdjacent){
        let cut=null;
        for(let mask=0;mask<(1<<candidates.length);mask++){
          const removed=candidates.filter((_,i)=>mask&(1<<i));
          if(cut&&removed.length>=cut.length)continue;
          if(!connected(new Set(removed),new Set()))cut=removed;
        }
        terminalVertexCut={size:cut.length,vertices:cut.map(i=>vertices[i])};
      }
    }
  }
  return {engine:'NEMESIS_STRUCTURAL_ROBUSTNESS_V1',domain:'SUPPLIED_UNDIRECTED_SIMPLE_GRAPH',vertexCount:n,edgeCount:edges.length,
    connected:initial.length===1,components:initial,articulationPoints,bridges,terminalEdgeCut,terminalVertexCut,
    note:'Exact on supplied graph only; edge/vertex failures assumed independently removable, not a prediction of physical reliability. null vertex cut for adjacent terminals means no internal-only separator.'};
}
