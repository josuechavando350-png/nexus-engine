import {object,array,integer,number} from './shared.mjs';
function prob(v,name){return number(v,name,0,1);}
function norm(v){const s=v.reduce((a,b)=>a+b,0);if(!(s>0))throw new TypeError('zero probability evidence');return v.map(x=>x/s);}
/** Exact enumeration of binary discrete-time Bayesian networks supplied as full conditional tables. */
export function filterDynamicBayes(input){
 object(input,'dbn',['initial','transition','emission','observations']);
 const initial=array(input.initial,'initial',2,64).map((v,i)=>prob(v,`initial[${i}]`));const states=initial.length;
 if((states&(states-1))!==0)throw new TypeError('initial must describe 2^n binary joint states');
 if(Math.abs(initial.reduce((a,b)=>a+b,0)-1)>1e-10)throw new TypeError('initial must sum to 1');
 const transition=array(input.transition,'transition',states,states).map((row,i)=>{const r=array(row,`transition[${i}]`,states,states).map((v,j)=>prob(v,`transition[${i}][${j}]`));if(Math.abs(r.reduce((a,b)=>a+b,0)-1)>1e-10)throw new TypeError('transition row must sum to 1');return r;});
 const emission=array(input.emission,'emission',states,states).map((row,i)=>{const r=array(row,`emission[${i}]`,2,64).map((v,j)=>prob(v,`emission[${i}][${j}]`));if(Math.abs(r.reduce((a,b)=>a+b,0)-1)>1e-10)throw new TypeError('emission row must sum to 1');return r;});
 const symbols=emission[0].length;if(emission.some(r=>r.length!==symbols))throw new TypeError('emission symbols mismatch');
 let current=[...initial],logLikelihood=0;const posterior=[];
 for(const [t,observation] of array(input.observations,'observations',1,512).entries()){
  if(observation!==null)integer(observation,`observations[${t}]`,0,symbols-1);
  const prior=t===0?current:Array.from({length:states},(_,j)=>current.reduce((s,v,i)=>s+v*transition[i][j],0));
  const weights=observation===null?prior:prior.map((v,i)=>v*emission[i][observation]);
  const scale=weights.reduce((s,v)=>s+v,0);if(!(scale>0))throw new TypeError(`observation ${t} has zero likelihood`);
  logLikelihood+=Math.log(scale);current=norm(weights);posterior.push(current);
 }
 return {domain:'FINITE_BINARY_JOINT_STATE_DBN',states,symbols,posterior,logLikelihood,note:'Known joint Markov transition and emission tables, no learned structure or continuous-time inference.'};
}
