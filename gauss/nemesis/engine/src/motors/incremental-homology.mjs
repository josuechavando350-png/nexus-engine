import {object,array,number,integer,unique} from './shared.mjs';
const key=v=>v.join(',');
function low(c){let p=-1;for(const x of c)if(x>p)p=x;return p;}

/** Incremental boundary reduction over F2. Failed appends leave state unchanged. */
export function createIncrementalHomology(options={}){
  object(options,'homology options',['maxSimplices','maxOperations'],[]);
  const capacity=integer(options.maxSimplices??10000,'maxSimplices',1,10000);
  const budget=integer(options.maxOperations??10000000,'maxOperations',1,100000000);
  let simplices=[],columns=[],index=new Map(),pivots=new Map(),births=new Set(),pairs=[],operations=0,entries=0;
  function snapshot(){
    const bar=(b,d)=>({dimension:simplices[b].vertices.length-1,birth:simplices[b].value,death:d===null?null:simplices[d].value,birthSimplex:[...simplices[b].vertices],deathSimplex:d===null?null:[...simplices[d].vertices]});
    const bars=pairs.map(([b,d])=>bar(b,d));for(const b of births)bars.push(bar(b,null));
    bars.sort((a,b)=>a.dimension-b.dimension||a.birth-b.birth||(a.death??Infinity)-(b.death??Infinity));
    return {operator:'INCREMENTAL_FILTERED_F2_V1',simplexCount:simplices.length,operations,reducedColumns:simplices.length,bars,coefficientField:'F2',filtrationEnd:simplices.at(-1)?.value??null,
      convention:'Append-only filtration; null deaths are right-censored at the current stream end. No deletion or zigzag persistence.'};
  }
  function append(batch){
    array(batch,'simplex batch',1,capacity);
    if(simplices.length+batch.length>capacity)throw new RangeError('simplex capacity exceeded');
    const incoming=batch.map(s=>{
      object(s,'simplex',['vertices','value']);
      const vertices=unique(array(s.vertices,'vertices',1,10).map(v=>integer(v,'vertex',0,1000000)),'vertices').sort((a,b)=>a-b);
      return {vertices,value:number(s.value,'filtration value')};
    }).sort((a,b)=>a.value-b.value||a.vertices.length-b.vertices.length||key(a.vertices).localeCompare(key(b.vertices)));
    if(simplices.length&&incoming[0].value<simplices.at(-1).value)throw new TypeError('filtration time cannot go backwards');
    // Only new columns are reduced. Existing columns are read-only.
    const nextIndex=new Map(index),nextPivots=new Map(pivots),nextBirths=new Set(births),newColumns=[],newPairs=[];
    let spent=0,addedEntries=0;
    const charge=n=>{spent+=n;if(spent>budget||operations+spent>100000000)throw new RangeError('incremental reduction work budget exceeded');};
    for(const s of incoming){
      const j=simplices.length+newColumns.length,k=key(s.vertices);
      if(nextIndex.has(k))throw new TypeError('duplicate simplex');
      const c=new Set();
      if(s.vertices.length>1)for(let i=0;i<s.vertices.length;i++){
        const f=key(s.vertices.filter((_,n)=>n!==i)),row=nextIndex.get(f);
        if(row===undefined)throw new TypeError('face missing or appears after coface');c.add(row);
      }
      while(c.size){
        charge(c.size);const p=low(c),prior=nextPivots.get(p);if(prior===undefined)break;
        const column=prior<columns.length?columns[prior]:newColumns[prior-columns.length];
        for(const r of column){charge(1);if(c.has(r))c.delete(r);else c.add(r);}
      }
      if(!c.size)nextBirths.add(j);
      else{const p=low(c);nextPivots.set(p,j);nextBirths.delete(p);newPairs.push([p,j]);}
      addedEntries+=c.size;if(entries+addedEntries>2000000)throw new RangeError('reduced-column storage budget exceeded');
      newColumns.push(c);nextIndex.set(k,j);
    }
    simplices.push(...incoming);columns.push(...newColumns);pairs.push(...newPairs);
    index=nextIndex;pivots=nextPivots;births=nextBirths;operations+=spent;entries+=addedEntries;
    return {...snapshot(),newColumnsReduced:newColumns.length,newOperations:spent};
  }
  return Object.freeze({append,snapshot});
}

export function streamFilteredHomology(input){
  object(input,'filtered stream',['batches','maxSimplices','maxOperations'],['batches']);
  const batches=array(input.batches,'batches',1,1000);
  if(batches.reduce((n,b)=>n+(Array.isArray(b)?b.length:0),0)>10000)throw new RangeError('stream simplex budget exceeded');
  const engine=createIncrementalHomology({maxSimplices:input.maxSimplices??10000,maxOperations:input.maxOperations??10000000});
  const updates=[];
  for(const batch of batches){const s=engine.append(batch);updates.push({simplexCount:s.simplexCount,newColumnsReduced:s.newColumnsReduced,newOperations:s.newOperations});}
  return {...engine.snapshot(),updates};
}

/** Fixed radius Rips complexes filtered by arrival time, not by radius. */
export function streamPointHomology(input){
  object(input,'point stream',['events','radius','maxHomology','maxOperations'],['events','radius','maxHomology']);
  const events=array(input.events,'events',1,256),radius=number(input.radius,'radius',0),dimension=integer(input.maxHomology,'maxHomology',0,4);
  const engine=createIncrementalHomology({maxOperations:input.maxOperations??10000000});
  const points=[],neighbors=[],updates=[];let coordinateDimension,lastTime=-Infinity,candidates=0;
  for(let id=0;id<events.length;id++){
    const event=events[id];object(event,'point event',['time','point']);
    const time=number(event.time,'time');if(time<lastTime)throw new TypeError('point time cannot go backwards');
    const point=array(event.point,'point',1,64).map(x=>number(x,'coordinate'));
    coordinateDimension??=point.length;if(point.length!==coordinateDimension)throw new TypeError('coordinate dimension mismatch');
    const adjacent=new Set();
    points.forEach((p,j)=>{const d=Math.hypot(...p.map((x,k)=>x-point[k]));if(!Number.isFinite(d))throw new RangeError('distance overflow');if(d<=radius)adjacent.add(j);});
    const batch=[{vertices:[id],value:time}],choices=[...adjacent];
    function extend(prefix,start){
      for(let k=start;k<choices.length;k++){
        if(++candidates>1000000)throw new RangeError('stream clique enumeration budget exceeded');
        const v=choices[k];if(prefix.some(p=>!neighbors[Math.max(p,v)].has(Math.min(p,v))))continue;
        const next=[...prefix,v];batch.push({vertices:[...next,id],value:time});
        if(batch.length>10000)throw new RangeError('stream clique capacity exceeded');
        if(next.length<dimension+1)extend(next,k+1);
      }
    }
    extend([],0);
    const s=engine.append(batch);points.push(point);neighbors.push(adjacent);lastTime=time;
    updates.push({event:id,time,simplexCount:s.simplexCount,newColumnsReduced:s.newColumnsReduced,newOperations:s.newOperations});
  }
  const result=engine.snapshot();
  return {...result,operator:'INCREMENTAL_ARRIVAL_RIPS_F2_V1',radius,maxHomology:dimension,bars:result.bars.filter(b=>b.dimension<=dimension),updates,
    convention:'Fixed radius; birth/death are point arrival times. Surviving bars are right-censored. No deletions or radius persistence across snapshots.'};
}
