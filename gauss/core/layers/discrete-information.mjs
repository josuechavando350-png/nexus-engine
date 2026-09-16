// Finite-alphabet information measures with normalized probability contracts.
const fail=m=>{throw new TypeError(m);};
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==keys.slice().sort().join('|'))fail(`expected exactly ${keys.join(',')}`);};
const scalar=(x,label,min=0,max=1)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max)fail(`${label} must be finite within [${min},${max}]`);return x;};
const finite=x=>{if(!Number.isFinite(x))fail('non-finite information result');return x;};
const vector=(x,name,min=1,max=64)=>{if(!Array.isArray(x)||x.length<min||x.length>max)fail(`${name} size invalid`);return x.map((v,i)=>scalar(v,`${name}[${i}]`));};
const pmf=(x,name,min=1,max=64)=>{const p=vector(x,name,min,max),sum=p.reduce((a,b)=>a+b,0);if(Math.abs(sum-1)>1e-9)fail(`${name} must sum to one`);return p;};
const pair=(input)=>{shape(input,['p','q']);const p=pmf(input.p,'p'),q=pmf(input.q,'q');if(p.length!==q.length)fail('alphabets must match');return [p,q];};
const freeze=Object.freeze;
const entropy=p=>-p.reduce((s,v)=>s+(v?v*Math.log(v):0),0);
const kl=(p,q)=>{let sum=0;for(let i=0;i<p.length;i++){if(!p[i])continue;if(!q[i])return null;sum+=p[i]*Math.log(p[i]/q[i]);}return finite(sum);};
export function kullbackLeiblerDivergence(input){const [p,q]=pair(input),value=kl(p,q);return freeze({kind:value===null?'POSITIVE_INFINITY':'FINITE',divergence:value});}
export function jensenShannonDivergence(input){const [p,q]=pair(input),m=p.map((v,i)=>(v+q[i])/2);return freeze({divergence:finite((kl(p,m)+kl(q,m))/2)});}
export function totalVariationDistance(input){const [p,q]=pair(input);return freeze({distance:finite(p.reduce((s,v,i)=>s+Math.abs(v-q[i]),0)/2)});}
export function hellingerDistance(input){const [p,q]=pair(input);return freeze({distance:finite(Math.sqrt(p.reduce((s,v,i)=>s+(Math.sqrt(v)-Math.sqrt(q[i]))**2,0)/2))});}
export function bhattacharyyaCoefficient(input){const [p,q]=pair(input);return freeze({coefficient:finite(p.reduce((s,v,i)=>s+Math.sqrt(v*q[i]),0))});}
export function chernoffInformation(input){const [p,q]=pair(input);if(p.every((v,i)=>v===q[i]))return freeze({kind:'FINITE',information:0,alpha:0.5});
 const coefficient=a=>p.reduce((s,v,i)=>s+((v===0||q[i]===0)?0:v**a*q[i]**(1-a)),0);
 let lo=0,hi=1;for(let it=0;it<100;it++){const l=lo+(hi-lo)/3,r=hi-(hi-lo)/3;if(coefficient(l)<coefficient(r))hi=r;else lo=l;}
 const alpha=(lo+hi)/2,bound=coefficient(alpha);return freeze({kind:bound===0?'POSITIVE_INFINITY':'FINITE',information:bound===0?null:finite(-Math.log(bound)),alpha:finite(alpha)});}
export function discreteWassersteinOne(input){shape(input,['positions','p','q']);const x=input.positions;if(!Array.isArray(x)||x.length<2||x.length>64)fail('positions length invalid');const points=x.map((v,i)=>scalar(v,`positions[${i}]`,-1e6,1e6));for(let i=1;i<points.length;i++)if(points[i]<=points[i-1])fail('positions must strictly increase');const p=pmf(input.p,'p'),q=pmf(input.q,'q');if(p.length!==points.length||q.length!==points.length)fail('position and distribution lengths differ');
 let imbalance=0,distance=0;for(let i=0;i<points.length-1;i++){imbalance+=p[i]-q[i];distance+=Math.abs(imbalance)*(points[i+1]-points[i]);}return freeze({distance:finite(distance)});}
export function discreteBayesianPosterior(input){shape(input,['prior','likelihood']);const prior=pmf(input.prior,'prior'),likelihood=vector(input.likelihood,'likelihood');if(prior.length!==likelihood.length)fail('hypothesis count mismatch');let evidence=0;const joint=prior.map((v,i)=>{const t=v*likelihood[i];evidence+=t;return t;});if(evidence<=0)fail('observed evidence has zero probability');return freeze({evidence:finite(evidence),posterior:freeze(joint.map(v=>finite(v/evidence)))});}
export function stationaryMarkovEntropyRate(input){shape(input,['transition','stationary']);const p=pmf(input.stationary,'stationary',2,20),m=input.transition;if(!Array.isArray(m)||m.length!==p.length)fail('transition size mismatch');const rows=m.map((row,i)=>pmf(row,`transition[${i}]`,p.length,p.length));
 for(let j=0;j<p.length;j++){const next=p.reduce((s,v,i)=>s+v*rows[i][j],0);if(Math.abs(next-p[j])>1e-8)fail('provided distribution is not stationary');}
 return freeze({entropyRate:finite(rows.reduce((sum,row,i)=>sum+p[i]*entropy(row),0))});}
export function conditionalMutualInformation(input){shape(input,['joint']);const cube=input.joint;if(!Array.isArray(cube)||cube.length<1||cube.length>8)fail('joint x dimension invalid');const X=cube.length,Y=cube[0]?.length,Z=cube[0]?.[0]?.length;
 if(!Number.isSafeInteger(Y)||Y<1||Y>8||!Number.isSafeInteger(Z)||Z<1||Z>8)fail('joint y/z dimensions invalid');let total=0;
 const data=cube.map((plane,i)=>{if(!Array.isArray(plane)||plane.length!==Y)fail('ragged Y dimension');return plane.map((row,j)=>{if(!Array.isArray(row)||row.length!==Z)fail('ragged Z dimension');return row.map((v,k)=>{const p=scalar(v,`joint[${i}][${j}][${k}]`);total+=p;return p;});});});
 if(Math.abs(total-1)>1e-9)fail('joint must sum to one');const pz=Array(Z).fill(0),pxz=Array.from({length:X},()=>Array(Z).fill(0)),pyz=Array.from({length:Y},()=>Array(Z).fill(0));
 for(let i=0;i<X;i++)for(let j=0;j<Y;j++)for(let k=0;k<Z;k++){const v=data[i][j][k];pz[k]+=v;pxz[i][k]+=v;pyz[j][k]+=v;}
 let value=0;for(let i=0;i<X;i++)for(let j=0;j<Y;j++)for(let k=0;k<Z;k++){const v=data[i][j][k];if(v)value+=v*Math.log(v*pz[k]/(pxz[i][k]*pyz[j][k]));}
 return freeze({conditionalMutualInformation:finite(value)});}
export function discreteMemorylessChannelCapacity(input){shape(input,['transition']);const m=input.transition;if(!Array.isArray(m)||m.length<2||m.length>8)fail('channel input dimension invalid');const cols=m[0]?.length;if(!Number.isSafeInteger(cols)||cols<2||cols>8)fail('channel output dimension invalid');const rows=m.map((row,i)=>pmf(row,`transition[${i}]`,cols,cols));
 const n=rows.length,prior=Array(n).fill(1/n);let p=prior,capacity=0,converged=false;
 for(let step=0;step<4000;step++){
  const q=Array.from({length:cols},(_,j)=>p.reduce((s,v,i)=>s+v*rows[i][j],0));
  const d=rows.map(row=>row.reduce((sum,v,j)=>sum+(v?v*Math.log(v/q[j]):0),0));
  const top=Math.max(...d),weights=p.map((v,i)=>v*Math.exp(d[i]-top)),total=weights.reduce((a,b)=>a+b,0);
  const next=weights.map(v=>v/total),lower=p.reduce((s,v,i)=>s+v*d[i],0),upper=Math.max(...d);
  capacity=finite(lower);if(upper-lower<1e-10){converged=true;p=next;break;}p=next;
 }
 if(!converged)fail('channel capacity convergence budget exceeded');return freeze({capacity,achievingInput:freeze(p)});}
export function conditionalShannonEntropy(input){shape(input,['joint']);const m=input.joint;if(!Array.isArray(m)||m.length<1||m.length>16)fail('joint rows invalid');const cols=m[0]?.length;if(!Number.isSafeInteger(cols)||cols<1||cols>16)fail('joint columns invalid');let total=0;
 const rows=m.map((row,i)=>{if(!Array.isArray(row)||row.length!==cols)fail('ragged joint');return row.map((v,j)=>{const x=scalar(v,`joint[${i}][${j}]`);total+=x;return x;});});if(Math.abs(total-1)>1e-9)fail('joint must sum to one');
 const marginal=Array.from({length:cols},(_,j)=>rows.reduce((s,row)=>s+row[j],0)),jointEntropy=entropy(rows.flat());return freeze({conditionalEntropy:finite(jointEntropy-entropy(marginal))});}
