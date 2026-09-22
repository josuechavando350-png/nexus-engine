import {object,array,integer,number} from './shared.mjs';
/** Discrete plug-in conditional mutual information I(sources_{t-lag}; target_t | target_{t-lag}, controls_{t-lag}). */
export function estimateMultivariateTransferEntropy(input){
 object(input,'transfer entropy',['target','sources','controls','lag'],['target','sources']);
 const y=array(input.target,'target',4,100000),N=y.length;
 const check=(v,label)=>array(v,label,N,N).map((x,i)=>{if(!Number.isSafeInteger(x)||x<0||x>255)throw new TypeError(`${label}[${i}] must be categorical integer 0..255`);return x;});
 const target=check(y,'target'),sources=array(input.sources,'sources',1,4).map((x,i)=>check(x,`sources[${i}]`)),controls=array(input.controls??[],'controls',0,4).map((x,i)=>check(x,`controls[${i}]`));
 const lag=integer(input.lag??1,'lag',1,Math.min(16,N-1)),joint=new Map(),xyz=new Map(),yz=new Map(),zCounts=new Map();
 const bump=(map,key)=>map.set(key,(map.get(key)??0)+1);
 for(let t=lag;t<N;t++){
  const z=[target[t-lag],...controls.map(s=>s[t-lag])],x=sources.map(s=>s[t-lag]),now=target[t];
  bump(joint,JSON.stringify([now,x,z]));bump(xyz,JSON.stringify([x,z]));bump(yz,JSON.stringify([now,z]));bump(zCounts,JSON.stringify(z));
 }
 const count=N-lag;let te=0;
 for(const [key,n] of joint){const [now,x,z]=JSON.parse(key);const cXZ=xyz.get(JSON.stringify([x,z])),cYZ=yz.get(JSON.stringify([now,z])),cZ=zCounts.get(JSON.stringify(z));te+=n/count*Math.log2(n*cZ/(cXZ*cYZ));}
 // Numerical cancellation of exact zero can yield ~1e-16.
 return {domain:'DISCRETE_CONDITIONAL_TRANSFER_ENTROPY_PLUGIN',samples:count,lag,sourceCount:sources.length,controlCount:controls.length,bits:Math.max(0,te),note:'Plug-in conditional mutual information of categorical lagged series; finite-sample bias and hidden confounding preclude causal identification or significance claims.'};
}
