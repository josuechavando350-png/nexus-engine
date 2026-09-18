/* Independent finite-sample counting, pairwise differences and empirical distribution references. */
import assert from 'node:assert/strict';
import {runFinalBank,range} from './final-common-v1.mjs';
const tags=['WEIGHTED_MOMENTS','SAMPLE_COVARIANCE','PEARSON_CORRELATION','SPEARMAN_MIDRANK','KENDALL_TAU_B','MEDIAN_ABSOLUTE_DEVIATION','WEIGHTED_QUANTILE','EMPIRICAL_CDF','TWO_SAMPLE_KS','MANN_WHITNEY_U','GINI_NONNEGATIVE','PEARSON_CHI_SQUARE'];
const total=a=>a.reduce((s,v)=>s+v,0),mean=a=>total(a)/a.length;
const median=a=>{const b=a.slice().sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
const ranks=a=>a.map(v=>1+a.filter(t=>t<v).length+(a.filter(t=>t===v).length-1)/2);
const corr=(x,y)=>{const a=x.map(v=>v-mean(x)),b=y.map(v=>v-mean(y)),top=total(a.map((v,i)=>v*b[i]));return Math.max(-1,Math.min(1,top/Math.sqrt(total(a.map(v=>v*v))*total(b.map(v=>v*v)))));};
function ref(tag,x){const a=x.samples??x.left,b=x.right;
 switch(tag){
 case 'WEIGHTED_MOMENTS':{const W=total(x.weights),m=total(a.map((v,i)=>v*x.weights[i]))/W,cm=r=>total(a.map((v,i)=>x.weights[i]*(v-m)**r))/W,V=cm(2);return {mean:m,variance:V,skewness:V?cm(3)/V**1.5:null,excessKurtosis:V?cm(4)/V**2-3:null};}
 case 'SAMPLE_COVARIANCE':return {covariance:total(a.map((v,i)=>v*b[i]))/(a.length-1)-a.length*mean(a)*mean(b)/(a.length-1),degreesOfFreedom:a.length-1};
 case 'PEARSON_CORRELATION':return {correlation:corr(a,b)};
 case 'SPEARMAN_MIDRANK':return {correlation:corr(ranks(a),ranks(b))};
 case 'KENDALL_TAU_B':{let c=0,d=0,tx=0,ty=0;for(let i=0;i<a.length;i++)for(let j=0;j<i;j++){const sa=Math.sign(a[i]-a[j]),sb=Math.sign(b[i]-b[j]);if(sa===0)tx++;if(sb===0)ty++;if(sa*sb>0)c++;if(sa*sb<0)d++;}const N=a.length*(a.length-1)/2;return {tau:(c-d)/Math.sqrt((N-tx)*(N-ty)),concordant:c,discordant:d,tiesX:tx,tiesY:ty};}
 case 'MEDIAN_ABSOLUTE_DEVIATION':{const m=median(a);return {median:m,mad:median(a.map(v=>Math.abs(v-m)))};}
 case 'WEIGHTED_QUANTILE':{const W=total(x.weights),order=a.map((v,i)=>({v,w:x.weights[i]})).sort((u,v)=>u.v-v.v);let cumulative=0;for(const item of order){cumulative+=item.w;if(item.w&&cumulative/W>=x.probability)return {quantile:item.v,cumulativeProbability:cumulative/W};}return {quantile:order.at(-1).v,cumulativeProbability:1};}
 case 'EMPIRICAL_CDF':return {probabilities:x.queries.map(q=>a.filter(v=>v<=q).length/a.length)};
 case 'TWO_SAMPLE_KS':{let best=0,location=Math.min(...a,...b);for(const v of [...new Set([...a,...b])].sort((x,y)=>x-y)){const delta=Math.abs(a.filter(t=>t<=v).length/a.length-b.filter(t=>t<=v).length/b.length);if(delta>best){best=delta;location=v;}}return {statistic:best,location};}
 case 'MANN_WHITNEY_U':{const u=total(a.map(v=>b.filter(w=>v>w).length+b.filter(w=>v===w).length/2));return {uLeft:u,uRight:a.length*b.length-u,rankSum:u+a.length*(a.length+1)/2};}
 case 'GINI_NONNEGATIVE':return {gini:a.reduce((z,v)=>z+total(a.map(w=>Math.abs(v-w))),0)/(2*a.length*total(a))};
 case 'PEARSON_CHI_SQUARE':{const matrix=x.counts,rows=matrix.map(total),cols=matrix[0].map((_,j)=>total(matrix.map(row=>row[j]))),N=total(rows);const chi=total(matrix.flatMap((row,i)=>row.map((v,j)=>{const E=rows[i]*cols[j]/N;return (v-E)**2/E;})));return {chiSquare:chi,degreesOfFreedom:(rows.length-1)*(cols.length-1),total:N};}
 default:throw Error('no independent descriptive statistic '+tag);
 }
}
function sample(tag,i,r){const n=2+r(6),a=range(n).map(()=>r(11)-5),b=range(n).map(()=>r(11)-5);if(['PEARSON_CORRELATION','SPEARMAN_MIDRANK','KENDALL_TAU_B'].includes(tag)){a[0]=0;a[1]=1;b[0]=0;b[1]=1;}if(tag==='SAMPLE_COVARIANCE'||tag==='PEARSON_CORRELATION'||tag==='SPEARMAN_MIDRANK'||tag==='KENDALL_TAU_B')return {left:a,right:b};
 if(tag==='TWO_SAMPLE_KS'||tag==='MANN_WHITNEY_U')return {left:a,right:range(2+r(6)).map(()=>r(13)-6)};
 if(tag==='WEIGHTED_MOMENTS')return {samples:a,weights:a.map(()=>1+r(5))};
 if(tag==='WEIGHTED_QUANTILE')return {samples:a,weights:a.map(()=>1+r(4)),probability:r(11)/10};
 if(tag==='EMPIRICAL_CDF')return {samples:a,queries:range(1+r(5)).map(()=>r(15)-7)};
 if(tag==='PEARSON_CHI_SQUARE'){const rows=2+r(2),cols=2+r(2);return {counts:range(rows).map(()=>range(cols).map(()=>1+r(8)))};}
 if(tag==='GINI_NONNEGATIVE')return {samples:a.map(v=>v+6)};
 return {samples:a};
}
function verify(actual,expected){assert.deepStrictEqual(Object.keys(actual).sort(),Object.keys(expected).sort());for(const k of Object.keys(expected)){if(Array.isArray(expected[k])){assert.equal(actual[k].length,expected[k].length);expected[k].forEach((v,i)=>assert.ok(Math.abs(v-actual[k][i])<=1e-10*Math.max(1,Math.abs(v)),`${k}[${i}] mismatch`));}else if(typeof expected[k]==='number')assert.ok(typeof actual[k]==='number'&&Number.isFinite(actual[k])&&Math.abs(actual[k]-expected[k])<=1e-10*Math.max(1,Math.abs(expected[k])),`${k} mismatch`);else assert.deepStrictEqual(actual[k],expected[k]);}}
const definitions=tags.map((tag,i)=>({id:`GAUSS.STATS.${tag}.${String(14+i).padStart(3,'0')}`,make:(j,r)=>sample(tag,j,r),reference:x=>ref(tag,x),verify}));
export const runFinalDescriptiveStatisticsBank=options=>runFinalBank({name:'AXIOMA 12 separate sample and rank statistic references',definitions,...options});
