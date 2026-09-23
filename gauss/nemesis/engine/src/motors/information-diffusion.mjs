import {object,array,integer,number,id,unique} from './shared.mjs';
import {vector} from './numerics.mjs';
/** Mass-conserving explicit finite-volume-like graph diffusion, symmetric nonnegative conductances. */
export function diffuseInformation(input){
 object(input,'diffusion',['nodes','edges','initial','dt','steps','diffusivity','sampleEvery'],['nodes','edges','initial','dt','steps','diffusivity']);
 const nodes=unique(array(input.nodes,'nodes',2,128).map((x,i)=>id(x,`nodes[${i}]`)),'nodes'),N=nodes.length,map=new Map(nodes.map((v,i)=>[v,i]));
 const init=vector(input.initial,'initial',N,N);if(init.some(v=>v<0))throw new TypeError('initial must be nonnegative');
 const D=number(input.diffusivity,'diffusivity',0,1e6),dt=number(input.dt,'dt',1e-12,1e6),steps=integer(input.steps,'steps',1,20000),every=integer(input.sampleEvery??steps,'sampleEvery',1,steps);
 const ed=array(input.edges,'edges',0,1024).map((e,i)=>{
  object(e,`edge[${i}]`,['from','to','conductance']);const a=map.get(e.from),b=map.get(e.to);
  if(a===undefined||b===undefined||a===b)throw new TypeError('edges must join distinct known nodes');
  return {a,b,c:number(e.conductance,'conductance',0,1e6)};
 });
 const degree=Array(N).fill(0),seen=new Set();for(const {a,b,c} of ed){const key=[a,b].sort((x,y)=>x-y).join(':');if(seen.has(key))throw new TypeError('duplicate edge');seen.add(key);degree[a]+=c;degree[b]+=c;}
 const maxDegree=Math.max(...degree);if(dt*D*maxDegree>1+1e-12)throw new RangeError('explicit Euler stability/positivity bound violated');
 let u=[...init];const total=init.reduce((a,b)=>a+b,0),trace=[{step:0,values:[...u]}];
 for(let t=1;t<=steps;t++){
  const next=[...u];for(const {a,b,c} of ed){const flux=dt*D*c*(u[a]-u[b]);next[a]-=flux;next[b]+=flux;}
  if(next.some(v=>v< -1e-9 || !Number.isFinite(v)))throw new RangeError('invalid diffusion state');u=next;
  if(t%every===0||t===steps)trace.push({step:t,values:[...u]});
 }
 const end=u.reduce((a,b)=>a+b,0);
 return {domain:'FINITE_UNDIRECTED_GRAPH_DIFFUSION',nodes,initialMass:total,finalMass:end,massError:end-total,finalValues:u,samples:trace,note:'Deterministic graph Laplacian diffusion of supplied scalar data; no general fluid mechanics or Navier–Stokes.'};
}
