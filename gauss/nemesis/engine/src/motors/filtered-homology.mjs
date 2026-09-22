import {object,array,integer,number,unique} from './shared.mjs';

const key=vertices=>vertices.join(',');
const faces=vertices=>vertices.length===1?[]:vertices.map((_,i)=>vertices.filter((_,j)=>i!==j));
const low=column=>{let m=-1;for(const i of column)if(i>m)m=i;return m;};

/** Standard filtered boundary reduction over F2. No floating-point algebra. */
export function filteredSimplicialHomology(input){
  object(input,'filtered homology',['simplices','maxOperations'],['simplices']);
  const budget=integer(input.maxOperations??10_000_000,'maxOperations',1,100_000_000);
  array(input.simplices,'simplices',1,10_000);
  const simplices=input.simplices.map((s,i)=>{
    object(s,`simplex ${i}`,['vertices','value']);
    const vertices=unique(array(s.vertices,'vertices',1,10).map(v=>integer(v,'vertex',0,1_000_000)),'vertices').sort((a,b)=>a-b);
    return {vertices,value:number(s.value,'filtration value'),dimension:vertices.length-1};
  }).sort((a,b)=>a.value-b.value||a.dimension-b.dimension||key(a.vertices).localeCompare(key(b.vertices)));
  const index=new Map();
  simplices.forEach((s,i)=>{const k=key(s.vertices);if(index.has(k))throw new TypeError('duplicate simplex');index.set(k,i);});
  const boundaries=simplices.map((s,i)=>new Set(faces(s.vertices).map(f=>{
    const j=index.get(key(f));
    if(j===undefined)throw new TypeError('complex missing a face');
    if(j>=i)throw new TypeError('face filtration exceeds coface filtration');
    return j;
  })));
  let operations=0,storedEntries=0;
  const reduced=[],pivots=new Map(),births=new Set(),bars=[];
  for(let j=0;j<simplices.length;j++){
    const column=boundaries[j];
    while(column.size){
      operations+=column.size;
      if(operations>budget)throw new RangeError('homology work budget exceeded; no partial barcode returned');
      const p=low(column),previous=pivots.get(p);
      if(previous===undefined)break;
      for(const r of reduced[previous]){
        if(++operations>budget)throw new RangeError('homology work budget exceeded; no partial barcode returned');
        if(column.has(r))column.delete(r);else column.add(r);
      }
    }
    reduced.push(column);
    storedEntries+=column.size;
    if(storedEntries>2_000_000)throw new RangeError('homology storage budget exceeded');
    if(!column.size)births.add(j);
    else{
      const p=low(column);pivots.set(p,j);births.delete(p);
      bars.push({dimension:simplices[p].dimension,birth:simplices[p].value,death:simplices[j].value,birthSimplex:simplices[p].vertices,deathSimplex:simplices[j].vertices});
    }
  }
  for(const p of births)bars.push({dimension:simplices[p].dimension,birth:simplices[p].value,death:null,birthSimplex:simplices[p].vertices,deathSimplex:null});
  bars.sort((a,b)=>a.dimension-b.dimension||a.birth-b.birth||(a.death??Infinity)-(b.death??Infinity));
  return {operator:'FILTERED_SIMPLICIAL_F2_V1',coefficientField:'F2',simplexCount:simplices.length,operations,bars,
    convention:'[birth,death); null means essential in the supplied finite complex; zero-length bars retained',
    limits:'Finite supplied complex, up to 10000 simplices and dimension 9; no out-of-core computation'};
}

/** Rips complex through dimension maxHomology+1, needed to kill H_maxHomology. */
export function ripsHigherHomology(input){
  object(input,'Rips homology',['points','maxHomology','maxRadius','maxOperations'],['points','maxHomology','maxRadius']);
  const points=array(input.points,'points',1,64).map(p=>array(p,'point',1,64).map(x=>number(x,'coordinate')));
  if(points.some(p=>p.length!==points[0].length))throw new TypeError('inconsistent point dimension');
  const dim=integer(input.maxHomology,'maxHomology',0,4),radius=number(input.maxRadius,'maxRadius',0);
  const distances=points.map(a=>points.map(b=>{
    const d=Math.hypot(...a.map((x,i)=>x-b[i]));
    if(!Number.isFinite(d))throw new TypeError('distance overflow');return d;
  }));
  const simplices=[];
  let candidates=0;
  function grow(vertices,start,value){
    for(let i=start;i<points.length;i++){
      if(++candidates>1_000_000)throw new RangeError('Rips enumeration budget exceeded');
      const next=Math.max(value,...vertices.map(j=>distances[i][j]));
      if(next>radius)continue;
      const v=[...vertices,i];simplices.push({vertices:v,value:next});
      if(simplices.length>10_000)throw new RangeError('Rips simplex budget exceeded');
      if(v.length<dim+2)grow(v,i+1,next);
    }
  }
  grow([],0,0);
  const result=filteredSimplicialHomology({simplices,maxOperations:input.maxOperations??10_000_000});
  return {...result,operator:'RIPS_HIGHER_F2_V1',bars:result.bars.filter(b=>b.dimension<=dim),maxHomology:dim,maxRadius:radius,
    convention:'[birth,death); null means surviving at maxRadius, not necessarily at infinity; zero-length bars retained'};
}
