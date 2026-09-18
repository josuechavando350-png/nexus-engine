/* AXIOMA: mathematical reference uses explicit index subsets and intervals, not GAUSS sequence kernels. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['SEQ_SUBSET_SUM_COUNT','SEQ_SUBSET_DISTINCT_SUMS','SEQ_SUBSET_SUM_HIST','SEQ_SUBSET_K_SUM','SEQ_SUBSET_XOR_HIST','SEQ_PAIR_SUM_HIST','SEQ_PAIR_PRODUCT_HIST','SEQ_SUBARRAY_SUM_COUNT','SEQ_LONGEST_SUBARRAY_SUM','SEQ_ALL_SUBARRAY_SUM','SEQ_ALL_SUBARRAY_SQUARES','SEQ_MAX_SUBARRAY','SEQ_MIN_SUBARRAY','SEQ_INCREASING_PAIRS','SEQ_NONDECREASING_PAIRS','SEQ_INVERSIONS','SEQ_LIS_COUNT','SEQ_LNDS_COUNT','SEQ_DISTINCT_SUBSEQUENCES','SEQ_ALTERNATING_RUN','SEQ_EQUAL_RUN','SEQ_SUBARRAY_GCD_ONE','SEQ_INCREASING_K','SEQ_LONGEST_PAL_RUN','SEQ_PAL_SUBARRAY_COUNT'];
const val=n=>({value:String(n)});
const gcd=(a,b)=>b?gcd(b,a%b):Math.abs(a);
const subsets=a=>seq(2**a.length).map(mask=>{const ids=a.flatMap((_,i)=>mask&(2**i)?[i]:[]);return {ids,values:ids.map(i=>a[i]),sum:ids.reduce((s,i)=>s+a[i],0)};});
const intervals=a=>a.flatMap((_,i)=>a.slice(i).map((_,off)=>{const j=i+off,v=a.slice(i,j+1);return {start:i,end:j,length:v.length,values:v,sum:v.reduce((s,z)=>s+z,0)};}));
const hist=values=>{const m=new Map();for(const v of values)m.set(v,(m.get(v)??0)+1);return {histogram:[...m].sort(([a],[b])=>a-b).map(([value,count])=>({value:String(value),count:String(count)}))};};
function input(tag,i,r){const n=i%13===0?0:1+i%7,values=seq(n).map(()=>tag==='SEQ_SUBSET_XOR_HIST'?r(16):r(9)-4);const x={values};if(['SEQ_SUBSET_SUM_COUNT','SEQ_SUBSET_K_SUM','SEQ_SUBARRAY_SUM_COUNT','SEQ_LONGEST_SUBARRAY_SUM'].includes(tag))x.target=i%9===0?0:r(17)-8;if(['SEQ_SUBSET_K_SUM','SEQ_INCREASING_K'].includes(tag))x.k=i%9===0?0:r(n+1);return x;}
function ref(tag,{values:a,target,k}){const ss=subsets(a),rr=intervals(a),pairs=[];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)pairs.push([a[i],a[j]]);
 switch(tag){
 case 'SEQ_SUBSET_SUM_COUNT':return val(ss.filter(s=>s.sum===target).length);
 case 'SEQ_SUBSET_DISTINCT_SUMS':return val(new Set(ss.map(s=>s.sum)).size);
 case 'SEQ_SUBSET_SUM_HIST':return hist(ss.map(s=>s.sum));
 case 'SEQ_SUBSET_K_SUM':return val(ss.filter(s=>s.ids.length===k&&s.sum===target).length);
 case 'SEQ_SUBSET_XOR_HIST':return hist(ss.map(s=>s.values.reduce((v,x)=>v^x,0)));
 case 'SEQ_PAIR_SUM_HIST':return hist(pairs.map(([x,y])=>x+y));
 case 'SEQ_PAIR_PRODUCT_HIST':return hist(pairs.map(([x,y])=>x*y));
 case 'SEQ_SUBARRAY_SUM_COUNT':return val(rr.filter(s=>s.sum===target).length);
 case 'SEQ_LONGEST_SUBARRAY_SUM':{const c=rr.filter(s=>s.sum===target).sort((x,y)=>y.length-x.length||x.start-y.start||x.end-y.end)[0];return {witness:c?{start:c.start,end:c.end,length:c.length}:null};}
 case 'SEQ_ALL_SUBARRAY_SUM':return val(rr.reduce((s,v)=>s+v.sum,0));
 case 'SEQ_ALL_SUBARRAY_SQUARES':return val(rr.reduce((s,v)=>s+v.sum*v.sum,0));
 case 'SEQ_MAX_SUBARRAY':case 'SEQ_MIN_SUBARRAY':{const c=rr.slice().sort((x,y)=>tag==='SEQ_MAX_SUBARRAY'?y.sum-x.sum||x.start-y.start||x.end-y.end:x.sum-y.sum||x.start-y.start||x.end-y.end)[0];return {witness:c?{value:String(c.sum),start:c.start,end:c.end}:null};}
 case 'SEQ_INCREASING_PAIRS':return val(pairs.filter(([x,y])=>x<y).length);
 case 'SEQ_NONDECREASING_PAIRS':return val(pairs.filter(([x,y])=>x<=y).length);
 case 'SEQ_INVERSIONS':return val(pairs.filter(([x,y])=>x>y).length);
 case 'SEQ_LIS_COUNT':case 'SEQ_LNDS_COUNT':{const candidates=ss.filter(s=>s.ids.length&&s.values.every((v,i)=>i===0||(tag==='SEQ_LIS_COUNT'?s.values[i-1]<v:s.values[i-1]<=v)));const length=Math.max(0,...candidates.map(s=>s.values.length));return {length,count:String(length?candidates.filter(s=>s.ids.length===length).length:1)};}
 case 'SEQ_DISTINCT_SUBSEQUENCES':return val(new Set(ss.filter(s=>s.ids.length).map(s=>JSON.stringify(s.values))).size);
 case 'SEQ_ALTERNATING_RUN':return {length:Math.max(0,...rr.filter(s=>s.values.every((v,i,t)=>i===0||(i===1?v!==t[0]:Math.sign(t[i-1]-t[i-2])*Math.sign(v-t[i-1])===-1))).map(s=>s.length))};
 case 'SEQ_EQUAL_RUN':return {length:Math.max(0,...rr.filter(s=>s.values.every(v=>v===s.values[0])).map(s=>s.length))};
 case 'SEQ_SUBARRAY_GCD_ONE':return val(rr.filter(s=>s.values.reduce((v,x)=>gcd(v,x),0)===1).length);
 case 'SEQ_INCREASING_K':return val(ss.filter(s=>s.ids.length===k&&s.values.every((v,i)=>i===0||s.values[i-1]<v)).length);
 case 'SEQ_LONGEST_PAL_RUN':{const c=rr.filter(s=>s.values.every((v,i)=>v===s.values[s.values.length-1-i])).sort((x,y)=>y.length-x.length||x.start-y.start)[0];return {start:c?.start??0,length:c?.length??0};}
 case 'SEQ_PAL_SUBARRAY_COUNT':return val(rr.filter(s=>s.values.every((v,i)=>v===s.values[s.values.length-1-i])).length);
 default:throw Error('missing sequence reference '+tag);
 }
}
export const runSequence438Bank=options=>runBatchBank({name:'AXIOMA independently enumerated integer sequences 301–325',prefix:'STATS',start:301,tags,input,reference:ref,...options});
