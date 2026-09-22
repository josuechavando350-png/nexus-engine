import {object,array,number} from './shared.mjs';
import {vector} from './numerics.mjs';
/** Vietoris–Rips 0/1-dimensional persistence, exact mod-2 boundary reduction on finite point clouds. */
export function computePersistentHomology(input){
 object(input,'persistent homology',['points','maxScale'],['points']);
 const points=array(input.points,'points',2,16).map((v,i)=>vector(v,`points[${i}]`,1,8));
 const n=points.length,d=points[0].length;if(points.some(v=>v.length!==d))throw new TypeError('inconsistent dimensions');
 const maxScale=number(input.maxScale??1e9,'maxScale',0,1e12);
 const dist=(i,j)=>Math.hypot(...points[i].map((x,k)=>x-points[j][k]));
 const simplices=[];
 for(let i=0;i<n;i++)simplices.push({v:[i],dim:0,scale:0});
 const ed=new Map();
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const x=dist(i,j);if(x<=maxScale){ed.set(`${i},${j}`,x);simplices.push({v:[i,j],dim:1,scale:x});}}
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++){
  const x=ed.get(`${i},${j}`),y=ed.get(`${i},${k}`),z=ed.get(`${j},${k}`);
  if(x!==undefined&&y!==undefined&&z!==undefined)simplices.push({v:[i,j,k],dim:2,scale:Math.max(x,y,z)});
 }
 simplices.sort((a,b)=>a.scale-b.scale||a.dim-b.dim||a.v.join(',').localeCompare(b.v.join(','),'en'));
 const map=new Map(simplices.map((v,i)=>[v.v.join(','),i])),lowToColumn=new Map(),zeroBirths=new Set(),pairs=[];
 const highest=bits=>bits.toString(2).length-1;
 for(let j=0;j<simplices.length;j++){
  const simplex=simplices[j];let bits=0n;
  if(simplex.dim>0)for(let k=0;k<simplex.v.length;k++){
   const face=simplex.v.filter((_,l)=>l!==k).join(',');bits^=1n<<BigInt(map.get(face));
  }
  while(bits){const low=highest(bits),other=lowToColumn.get(low);if(other===undefined)break;bits^=other;}
  if(bits){const low=highest(bits);lowToColumn.set(low,bits);pairs.push({birth:low,death:j});}
  else zeroBirths.add(j);
 }
 const killed=new Set(pairs.map(p=>p.birth));
 const intervals=[];
 for(const p of pairs){const birth=simplices[p.birth],death=simplices[p.death];if(birth.dim<=1)intervals.push({dimension:birth.dim,birth:birth.scale,death:death.scale,generatingSimplex:birth.v});}
 for(const j of zeroBirths)if(!killed.has(j)&&simplices[j].dim<=1)intervals.push({dimension:simplices[j].dim,birth:simplices[j].scale,death:null,generatingSimplex:simplices[j].v});
 intervals.sort((a,b)=>a.dimension-b.dimension||a.birth-b.birth||(a.death??Infinity)-(b.death??Infinity));
 return {domain:'VIETORIS_RIPS_H0_H1_Z2',pointCount:n,simplexCount:simplices.length,intervals,h0:intervals.filter(x=>x.dimension===0),h1:intervals.filter(x=>x.dimension===1),note:'Rips filtration through triangles, H0/H1 only; null death denotes persistence beyond maxScale. Not a general high-dimensional TDA engine.'};
}
