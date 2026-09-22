import {object,array,integer,number} from './shared.mjs';
import {seeded} from './numerics.mjs';
/** Deterministic-seed particle swarm for bounded quadratic cost and linear <= constraints. */
export function optimizeConstrainedSwarm(input){
 object(input,'swarm',['bounds','target','constraints','particles','iterations','seed','inertia','cognitive','social'],['bounds','target','particles','iterations']);
 const bounds=array(input.bounds,'bounds',1,16).map((v,i)=>{const b=array(v,`bounds[${i}]`,2,2).map((x,j)=>number(x,`bound[${i}][${j}]`,-1e6,1e6));if(!(b[0]<b[1]))throw new TypeError('invalid bounds');return b;});
 const d=bounds.length,target=array(input.target,'target',d,d).map(v=>number(v,'target',-1e6,1e6));
 const constraints=array(input.constraints??[],'constraints',0,64).map((c,i)=>{object(c,`constraint[${i}]`,['coefficients','max']);return {coefficients:array(c.coefficients,'coefficients',d,d).map(x=>number(x,'coefficient',-1e6,1e6)),max:number(c.max,'max',-1e9,1e9)};});
 const particles=integer(input.particles,'particles',2,256),iterations=integer(input.iterations,'iterations',1,2000),rng=seeded(integer(input.seed??1,'seed',0,4294967295));
 const inertia=number(input.inertia??.7,'inertia',0,1),cognitive=number(input.cognitive??1.4,'cognitive',0,4),social=number(input.social??1.4,'social',0,4);
 const feasible=p=>constraints.every(c=>c.coefficients.reduce((s,v,i)=>s+v*p[i],0)<=c.max+1e-10);
 const cost=p=>p.reduce((s,v,i)=>s+(v-target[i])**2,0),score=p=>cost(p)+1e6*constraints.reduce((s,c)=>s+Math.max(0,c.coefficients.reduce((t,v,i)=>t+v*p[i],0)-c.max)**2,0);
 let best=null,bestCost=Infinity;const members=Array.from({length:particles},()=>{const pos=bounds.map(([lo,hi])=>lo+(hi-lo)*rng());const velocity=bounds.map(()=>0);return {pos,velocity,personal:[...pos],personalScore:score(pos)};});
 // Project the specified target into bounds as a known valid candidate, not a substitute for search.
 const project=bounds.map(([lo,hi],i)=>Math.max(lo,Math.min(hi,target[i])));
 const consider=p=>{if(feasible(p)&&cost(p)<bestCost){best=[...p];bestCost=cost(p);}};
 consider(project);for(const p of members)consider(p.pos);
 let global=members.reduce((a,b)=>score(a.pos)<=score(b.pos)?a:b).pos.slice();let globalScore=score(global);
 for(let t=0;t<iterations;t++)for(const p of members){for(let j=0;j<d;j++){
  const [lo,hi]=bounds[j];p.velocity[j]=inertia*p.velocity[j]+cognitive*rng()*(p.personal[j]-p.pos[j])+social*rng()*(global[j]-p.pos[j]);
  p.pos[j]=Math.max(lo,Math.min(hi,p.pos[j]+p.velocity[j]));
 }const s=score(p.pos);if(s<p.personalScore){p.personal=[...p.pos];p.personalScore=s;}
 if(s<globalScore){global=[...p.pos];globalScore=s;}consider(p.pos);
 }
 return {domain:'BOUNDED_QUADRATIC_CONSTRAINED_PSO',status:best?'FEASIBLE_CANDIDATE':'NO_FEASIBLE_CANDIDATE_FOUND',bestPoint:best,bestCost:best?bestCost:null,iterations,particles,note:'Heuristic search; absence of a candidate is not a proof of infeasibility or global optimality.'};
}
