import {object,array,number,integer} from './shared.mjs';
import {seeded,normal,cholesky} from './numerics.mjs';
/** Sample from a finite Gaussian field with a separable space-time exponential kernel. */
export function sampleSpatiotemporalField(input){
 object(input,'field',['points','spatialScale','temporalScale','variance','nugget','mean','seed']);
 const points=array(input.points,'points',1,128).map((p,i)=>{object(p,`point[${i}]`,['x','y','t']);return [number(p.x,'x',-1e9,1e9),number(p.y,'y',-1e9,1e9),number(p.t,'t',-1e9,1e9)];});
 const spatialScale=number(input.spatialScale,'spatialScale',1e-9,1e9),temporalScale=number(input.temporalScale,'temporalScale',1e-9,1e9),variance=number(input.variance,'variance',1e-12,1e9),nugget=number(input.nugget??0,'nugget',0,1e6),mean=number(input.mean??0,'mean',-1e9,1e9),seed=integer(input.seed??1,'seed',0,4294967295);
 const covariance=points.map((p,i)=>points.map((q,j)=>variance*Math.exp(-Math.hypot(p[0]-q[0],p[1]-q[1])/spatialScale-Math.abs(p[2]-q[2])/temporalScale)+(i===j?nugget:0)));
 // True duplicates without nugget produce singular covariance; do not silently invent noise.
 const L=cholesky(covariance),rng=seeded(seed),z=points.map(()=>normal(rng));
 const sample=points.map((_,i)=>mean+L[i].reduce((s,v,j)=>s+v*z[j],0));
 return {domain:'FINITE_GAUSSIAN_SPATIOTEMPORAL_FIELD',sample,covariance,seed,note:'One reproducible Gaussian draw under a user-specified covariance kernel; no learned geophysical process.'};
}
