// Finite-sample descriptive statistics; bounded data and explicit degeneracy contracts.
const fail = m => { throw new TypeError(m); };
const shape = (x, keys) => {if (!x || typeof x!=='object' || Array.isArray(x) || Object.keys(x).sort().join('|')!==keys.slice().sort().join('|')) fail(`expected exactly ${keys.join(',')}`);};
const scalar = (x, label, min=-1e6, max=1e6) => {if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max)fail(`${label} must be finite in [${min},${max}]`);return x;};
const vec = (x, label, min=1, max=128) => {if(!Array.isArray(x)||x.length<min||x.length>max)fail(`${label} length invalid`);return x.map((v,i)=>scalar(v,`${label}[${i}]`));};
const same = (a,b) => {if(a.length!==b.length)fail('vector lengths differ');};
const finite=x=>{if(!Number.isFinite(x))fail('nonfinite numerical result');return x;};
const freeze = o=>Object.freeze(o);
const avg=x=>x.reduce((s,v)=>s+v,0)/x.length;
const ranks=x=>{const sorted=x.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);const result=Array(x.length);for(let a=0;a<sorted.length;){let b=a+1;while(b<sorted.length&&sorted[b].v===sorted[a].v)b++;for(let i=a;i<b;i++)result[sorted[i].i]=(a+1+b)/2;a=b;}return result;};
export function weightedCentralMoments(input){shape(input,['samples','weights']);const x=vec(input.samples,'samples'),w=vec(input.weights,'weights');same(x,w);if(w.some(v=>v<0))fail('weights must be nonnegative');const sum=w.reduce((a,b)=>a+b,0);if(sum<=0)fail('weights sum must be positive');
 const mean=x.reduce((s,v,i)=>s+v*w[i],0)/sum,variance=x.reduce((s,v,i)=>s+w[i]*(v-mean)**2,0)/sum;
 const skewness=variance===0?null:finite(x.reduce((s,v,i)=>s+w[i]*(v-mean)**3,0)/sum/variance**1.5);
 const excessKurtosis=variance===0?null:finite(x.reduce((s,v,i)=>s+w[i]*(v-mean)**4,0)/sum/variance**2-3);
 return freeze({mean:finite(mean),variance:finite(variance),skewness,excessKurtosis});}
export function sampleCovariance(input){shape(input,['left','right']);const x=vec(input.left,'left',2),y=vec(input.right,'right',2);same(x,y);const mx=avg(x),my=avg(y);
 return freeze({covariance:finite(x.reduce((s,v,i)=>s+(v-mx)*(y[i]-my),0)/(x.length-1)),degreesOfFreedom:x.length-1});}
export function pearsonCorrelation(input){shape(input,['left','right']);const x=vec(input.left,'left',2),y=vec(input.right,'right',2);same(x,y);const mx=avg(x),my=avg(y);
 let cross=0,sx=0,sy=0;for(let i=0;i<x.length;i++){const a=x[i]-mx,b=y[i]-my;cross+=a*b;sx+=a*a;sy+=b*b;}if(sx===0||sy===0)fail('correlation undefined for constant sample');
 return freeze({correlation:finite(Math.max(-1,Math.min(1,cross/Math.sqrt(sx*sy))))});}
export function spearmanRankCorrelation(input){shape(input,['left','right']);const x=vec(input.left,'left',2),y=vec(input.right,'right',2);same(x,y);return pearsonCorrelation({left:ranks(x),right:ranks(y)});}
export function kendallTauB(input){shape(input,['left','right']);const x=vec(input.left,'left',2),y=vec(input.right,'right',2);same(x,y);let concordant=0,discordant=0,tiesX=0,tiesY=0;
 for(let i=0;i<x.length;i++)for(let j=i+1;j<x.length;j++){const dx=Math.sign(x[i]-x[j]),dy=Math.sign(y[i]-y[j]);if(dx===0)tiesX++;if(dy===0)tiesY++;if(dx*dy>0)concordant++;if(dx*dy<0)discordant++;}
 const pairs=x.length*(x.length-1)/2,denom=Math.sqrt((pairs-tiesX)*(pairs-tiesY));if(!denom)fail('Kendall tau undefined when a variable is constant');
 return freeze({tau:finite((concordant-discordant)/denom),concordant,discordant,tiesX,tiesY});}
export function medianAbsoluteDeviation(input){shape(input,['samples']);const x=vec(input.samples,'samples');const median=a=>{const s=a.slice().sort((u,v)=>u-v),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
 const center=median(x);return freeze({median:center,mad:finite(median(x.map(v=>Math.abs(v-center))))});}
export function weightedEmpiricalQuantile(input){shape(input,['samples','weights','probability']);const x=vec(input.samples,'samples'),w=vec(input.weights,'weights');same(x,w);const p=scalar(input.probability,'probability',0,1);if(w.some(v=>v<0))fail('negative weight');const total=w.reduce((a,b)=>a+b,0);if(total<=0)fail('positive weight sum required');const rows=x.map((v,i)=>[v,w[i]]).sort((a,b)=>a[0]-b[0]);let cumul=0;
 for(const [value,weight] of rows){cumul+=weight;if(weight>0 && cumul/total>=p)return freeze({quantile:value,cumulativeProbability:finite(cumul/total)});}
 return freeze({quantile:rows.at(-1)[0],cumulativeProbability:1});}
export function empiricalCdf(input){shape(input,['samples','queries']);const x=vec(input.samples,'samples'),q=vec(input.queries,'queries');const ordered=x.slice().sort((a,b)=>a-b);
 const probabilities=q.map(v=>{let lo=0,hi=ordered.length;while(lo<hi){const mid=(lo+hi)>>1;if(ordered[mid]<=v)lo=mid+1;else hi=mid;}return lo/ordered.length;});
 return freeze({probabilities:freeze(probabilities)});}
export function twoSampleKolmogorovSmirnov(input){shape(input,['left','right']);const x=vec(input.left,'left'),y=vec(input.right,'right'),all=[...new Set([...x,...y])].sort((a,b)=>a-b);let d=0,location=all[0];
 for(const v of all){const a=x.filter(z=>z<=v).length/x.length,b=y.filter(z=>z<=v).length/y.length,diff=Math.abs(a-b);if(diff>d){d=diff;location=v;}}
 return freeze({statistic:finite(d),location});}
export function mannWhitneyRankSum(input){shape(input,['left','right']);const x=vec(input.left,'left'),y=vec(input.right,'right'),r=ranks([...x,...y]);const rankSum=r.slice(0,x.length).reduce((a,b)=>a+b,0);
 const u=rankSum-x.length*(x.length+1)/2;return freeze({uLeft:finite(u),uRight:finite(x.length*y.length-u),rankSum:finite(rankSum)});}
export function nonnegativeGiniCoefficient(input){shape(input,['samples']);const x=vec(input.samples,'samples');if(x.some(v=>v<0))fail('Gini requires nonnegative data');const sorted=x.slice().sort((a,b)=>a-b),sum=sorted.reduce((a,b)=>a+b,0);if(sum<=0)fail('Gini undefined for all-zero data');
 const weighted=sorted.reduce((s,v,i)=>s+(i+1)*v,0);return freeze({gini:finite(2*weighted/(x.length*sum)-(x.length+1)/x.length)});}
export function pearsonChiSquareIndependence(input){shape(input,['counts']);const a=input.counts;if(!Array.isArray(a)||a.length<2||a.length>12||!Array.isArray(a[0])||a[0].length<2||a[0].length>12)fail('bounded rectangular contingency table required');const cols=a[0].length;
 const rows=a.map((row,i)=>{if(!Array.isArray(row)||row.length!==cols)fail('ragged counts');return row.map((v,j)=>{if(!Number.isSafeInteger(v)||v<0||v>100000)fail(`counts[${i}][${j}] invalid`);return v;});});
 const rt=rows.map(row=>row.reduce((a,b)=>a+b,0)),ct=Array.from({length:cols},(_,j)=>rows.reduce((s,row)=>s+row[j],0)),n=rt.reduce((a,b)=>a+b,0);if(n===0||rt.some(v=>v===0)||ct.some(v=>v===0))fail('expected cells must be positive');
 let chi=0;for(let i=0;i<rows.length;i++)for(let j=0;j<cols;j++){const expected=rt[i]*ct[j]/n;chi+=(rows[i][j]-expected)**2/expected;}
 return freeze({chiSquare:finite(chi),degreesOfFreedom:(rows.length-1)*(cols-1),total:n});}
