import {object,array,number,integer} from './shared.mjs';
import {seeded,normal} from './numerics.mjs';
const sum=a=>a.reduce((s,x)=>s+x,0);
function parameter(t){number(t,'theta',0,20);if(t>0&&t<0.0001)throw new RangeError('theta must be zero or at least 0.0001');return t;}
function uniforms(u){array(u,'uniform coordinates',2,32);return u.map(x=>{number(x,'uniform coordinate',0,1);if(x===0||x===1)throw new RangeError('density coordinates must be strictly inside (0,1)');return x;});}
function logS(logs,t){const a=logs.map(x=>-t*x),m=Math.max(...a);return m<500?Math.log1p(sum(a.map(Math.expm1))):m+Math.log(sum(a.map(x=>Math.exp(x-m)))-(a.length-1)*Math.exp(-m));}
function logDensity(logs,t){if(t===0)return 0;const d=logs.length;let c=0;for(let i=1;i<d;i++)c+=Math.log1p(i*t);return c-(1+t)*sum(logs)-(d+1/t)*logS(logs,t);}
function cdf(logs,t){return Math.exp(t===0?sum(logs):-logS(logs,t)/t);}
export function evaluateMultivariateClayton(input){
  object(input,'Clayton evaluation',['u','theta']);const u=uniforms(input.u),theta=parameter(input.theta),logs=u.map(Math.log);
  const ld=logDensity(logs,theta);
  return {operator:'MULTIVARIATE_CLAYTON_V1',dimension:u.length,theta,cdf:cdf(logs,theta),logDensity:ld,density:ld>Math.log(Number.MAX_VALUE)?'Infinity':Math.exp(ld),kendallTau:theta/(theta+2),pairwiseLowerTailDependence:theta===0?0:2**(-1/theta),jointLowerTailGivenOne:theta===0?0:u.length**(-1/theta),assumptions:'Exchangeable positive-dependence Clayton family; uniform marginal inputs; no negative dependence or automatic marginal fitting'};
}
function logGammaSample(shape,rng){
  if(shape<1)return logGammaSample(shape+1,rng)+Math.log(rng())/shape;
  const d=shape-1/3,c=1/Math.sqrt(9*d);
  for(let k=0;k<10000;k++){
    const x=normal(rng),a=1+c*x;if(a<=0)continue;
    const v=a*a*a,u=rng();
    if(u<1-0.0331*x**4||Math.log(u)<0.5*x*x+d*(1-v+Math.log(v)))return Math.log(d)+Math.log(v);
  }
  throw new RangeError('gamma rejection budget exceeded');
}
const softplus=x=>x>40?x:Math.log1p(Math.exp(x));
export function sampleMultivariateClayton(input){
  object(input,'Clayton sampling',['theta','dimension','count','seed']);
  const theta=parameter(input.theta),dimension=integer(input.dimension,'dimension',2,32),count=integer(input.count,'count',1,100000),rng=seeded(integer(input.seed,'seed',0,2**32-1));
  if(count*dimension>1000000)throw new RangeError('copula sample output budget exceeded');
  const samples=[];
  for(let i=0;i<count;i++){
    const logV=theta===0?null:logGammaSample(1/theta,rng);
    const row=Array.from({length:dimension},()=>theta===0?rng():Math.exp(-softplus(Math.log(-Math.log(rng()))-logV)/theta));
    if(row.some(x=>!Number.isFinite(x)||x<=0||x>=1))throw new RangeError('sample outside representable open unit interval');
    samples.push(row);
  }
  return {operator:'CLAYTON_GAMMA_FRAILTY_SAMPLER_V1',theta,dimension,seed:input.seed,samples};
}
export function fitMultivariateClayton(input){
  object(input,'Clayton fit',['samples','maxTheta','tolerance'],['samples']);
  const samples=array(input.samples,'samples',20,10000).map(uniforms),d=samples[0].length;
  if(samples.some(x=>x.length!==d))throw new TypeError('sample dimension mismatch');
  if(samples.length*d>100000)throw new RangeError('copula fitting work budget exceeded');
  const upper=number(input.maxTheta??20,'maxTheta',0.01,20),tolerance=number(input.tolerance??1e-7,'tolerance',1e-10,0.01),logs=samples.map(row=>row.map(Math.log));
  const likelihood=t=>sum(logs.map(row=>logDensity(row,t)));
  const grid=Array.from({length:65},(_,i)=>0.0001*(upper/0.0001)**(i/64));
  const values=grid.map(likelihood);let best=0;for(let i=1;i<grid.length;i++)if(values[i]>values[best])best=i;
  let a=grid[Math.max(0,best-1)],b=grid[Math.min(64,best+1)],iterations=0;
  const ratio=(Math.sqrt(5)-1)/2;
  let x=b-ratio*(b-a),y=a+ratio*(b-a),fx=likelihood(x),fy=likelihood(y);
  while(b-a>tolerance&&iterations++<128){
    if(fx>fy){b=y;y=x;fy=fx;x=b-ratio*(b-a);fx=likelihood(x);}
    else{a=x;x=y;fx=fy;y=a+ratio*(b-a);fy=likelihood(y);}
  }
  const candidates=[0,0.0001,upper,x,y,grid[best]];let theta=0,ll=0;
  for(const t of candidates){const v=likelihood(t);if(v>ll){theta=t;ll=v;}}
  return {operator:'CLAYTON_MAXIMUM_LIKELIHOOD_FIT_V1',dimension:d,count:samples.length,theta,logLikelihood:ll,kendallTau:theta/(theta+2),status:b-a<=tolerance?'CONVERGED':'ITERATION_LIMIT',iterations,atBoundary:theta===0||theta===upper||theta===0.0001,searchBracket:[a,b],method:'Log-spaced grid followed by golden-section refinement of the best neighboring bracket; not a global optimality certificate',assumptions:'Supplied observations have uniform marginals; parametric Clayton model only. Marginal estimation uncertainty is not included.'};
}
export function calibrateClaytonLowerTail(input){
  object(input,'Clayton calibration',['samples','theta','thresholds']);
  const samples=array(input.samples,'held-out samples',20,100000).map(uniforms),d=samples[0].length,theta=parameter(input.theta);
  if(samples.some(r=>r.length!==d))throw new TypeError('sample dimension mismatch');
  const thresholds=array(input.thresholds,'thresholds',1,32).map(t=>number(t,'threshold',0.0001,0.9999));
  if(samples.length*d*thresholds.length>10000000)throw new RangeError('tail calibration work budget exceeded');
  const n=samples.length,z=1.959963984540054;
  return {operator:'CLAYTON_HELD_OUT_LOWER_TAIL_V1',dimension:d,count:n,theta,results:thresholds.map(q=>{
    const count=samples.filter(row=>row.every(v=>v<=q)).length,p=count/n,den=1+z*z/n;
    const center=(p+z*z/(2*n))/den,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den,predicted=cdf(Array(d).fill(Math.log(q)),theta);
    return {threshold:q,count,empirical:p,predicted,residual:p-predicted,wilson95:[Math.max(0,center-half),Math.min(1,center+half)]};
  }),interpretation:'Binomial Wilson intervals for independent held-out observations; pointwise, not simultaneous. Caller must separate fitting data and account for serial dependence.'};
}
