import {object,array,vector,number} from './finite-tools.mjs';
function corr(x,y){const n=x.length,mx=x.reduce((a,b)=>a+b,0)/n,my=y.reduce((a,b)=>a+b,0)/n;let a=0,b=0,c=0;for(let i=0;i<n;i++){const u=x[i]-mx,v=y[i]-my;a+=u*v;b+=u*u;c+=v*v;}return b*c? a/Math.sqrt(b*c):null;}
/** Inverse of a KNOWN bijective triangular nonlinear observation map. Blind nonlinear ICA is unidentifiable without extra assumptions. */
export function invertKnownNonlinearMix(input){object(input,'unmix',['observations','alpha'],['observations','alpha']);const obs=array(input.observations,'observations',8,100000),alpha=number(input.alpha,'alpha',-100,100);
 const sources=obs.map((row,i)=>{const [x,y]=vector(row,`observations[${i}]`,2,2);if(Math.abs(x)>=1)throw new TypeError('tanh observation must lie strictly inside (-1,1)');const s0=Math.atanh(x),s1=y-alpha*s0*s0; if(!Number.isFinite(s1))throw new RangeError('nonfinite source');return [s0,s1];});
 return {domain:'KNOWN_INVERTIBLE_NONLINEAR_ICA_MODEL',sources,pearsonCorrelation:corr(sources.map(s=>s[0]),sources.map(s=>s[1])),reconstructionMaxError:sources.reduce((m,s,i)=>Math.max(m,Math.abs(Math.tanh(s[0])-obs[i][0]),Math.abs(s[1]+alpha*s[0]**2-obs[i][1])),0),note:'Known mixing law and coefficient supplied by caller; correlation is not a test of independence, and blind nonlinear ICA is not claimed.'};
}
