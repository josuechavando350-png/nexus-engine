/* Independent exact integer-slot coverage oracle, with exhaustive scheduling and room-coloring checks. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['INTERVAL_MERGE','INTERVAL_UNION_LENGTH','INTERVAL_TOTAL_LENGTH','INTERVAL_MAX_OVERLAP','INTERVAL_OVERLAP_SEGMENTS','INTERVAL_DEPTH_PROFILE','INTERVAL_OVERLAP_PAIRS','INTERVAL_DISJOINT_PAIRS','INTERVAL_CONTAINMENT_PAIRS','INTERVAL_ACTIVE_INDICES','INTERVAL_ACTIVE_COUNT','INTERVAL_NEXT_START','INTERVAL_NEXT_END','INTERVAL_WINDOW_GAPS','INTERVAL_WINDOW_COVERAGE','INTERVAL_LONGEST_GAP','INTERVAL_EARLIEST_FINISH','INTERVAL_LATEST_START','INTERVAL_MAX_DISJOINT','INTERVAL_ROOM_PARTITION','INTERVAL_SET_INTERSECTION','INTERVAL_SET_DIFFERENCE','INTERVAL_SET_SYMMETRIC','INTERVAL_DEPTH_HISTOGRAM','INTERVAL_EXCLUSIVE_LENGTH'];
const timeTags=new Set(['INTERVAL_ACTIVE_INDICES','INTERVAL_ACTIVE_COUNT','INTERVAL_NEXT_START','INTERVAL_NEXT_END']);
const windowTags=new Set(['INTERVAL_WINDOW_GAPS','INTERVAL_WINDOW_COVERAGE','INTERVAL_LONGEST_GAP']);
const twoTags=new Set(['INTERVAL_SET_INTERSECTION','INTERVAL_SET_DIFFERENCE','INTERVAL_SET_SYMMETRIC']);
function source(i,r){const count=i%11===0?0:1+r(7);return seq(count).map(k=>{const s=-5+r(13),e=s+1+r(6);return [s,e];});}
function input(tag,i,r){const intervals=source(i,r);if(timeTags.has(tag))return {intervals,time:i%6===0?-8:i%6===1?20:-5+r(16)};if(windowTags.has(tag)){const start=-7+r(7),end=start+1+r(18);return {intervals,start,end};}if(twoTags.has(tag))return {left:intervals,right:source(i+7,r)};return {intervals};}
const depth=(a,t)=>a.filter(([s,e])=>s<=t&&t<e).length;
function segments(a){if(!a.length)return [];const marks=[...new Set(a.flat())].sort((a,b)=>a-b);return marks.slice(0,-1).map((t,i)=>[t,marks[i+1],depth(a,t)]);}
function ranges(a){if(!a.length)return [];const lo=Math.min(...a.flat()),hi=Math.max(...a.flat());const out=[];for(let t=lo;t<hi;t++)if(depth(a,t)>0){if(out.length&&out.at(-1)[1]===t)out.at(-1)[1]=t+1;else out.push([t,t+1]);}return out;}
function gaps(a,s,e){const out=[];for(let t=s;t<e;t++)if(depth(a,t)===0){if(out.length&&out.at(-1)[1]===t)out.at(-1)[1]=t+1;else out.push([t,t+1]);}return out;}
const selected=a=>{const out=[];for(let mask=0;mask<2**a.length;mask++){const indices=seq(a.length).filter(j=>Math.floor(mask/2**j)%2);if(indices.every((v,i)=>indices.slice(i+1).every(w=>a[v][1]<=a[w][0]||a[w][1]<=a[v][0])))out.push(indices);}return out;};
function setOp(a,b,kind){if(!a.length&&!b.length)return [];const marks=[...new Set([...a.flat(),...b.flat()])].sort((a,b)=>a-b),out=[];for(let j=0;j<marks.length-1;j++){const s=marks[j],e=marks[j+1],A=depth(a,s)>0,B=depth(b,s)>0,keep=kind==='intersection'?A&&B:kind==='difference'?A&&!B:A!==B;if(keep){if(out.length&&out.at(-1)[1]===s)out.at(-1)[1]=e;else out.push([s,e]);}}return out;}
function reference(tag,x){const a=x.intervals??x.left??[],b=x.right??[],ss=segments(a),ids=seq(a.length),t=x.time,s=x.start,e=x.end;
 switch(tag){
 case 'INTERVAL_MERGE':return {intervals:ranges(a)};
 case 'INTERVAL_UNION_LENGTH':return {length:ranges(a).reduce((v,[l,r])=>v+r-l,0)};
 case 'INTERVAL_TOTAL_LENGTH':return {length:a.reduce((v,[l,r])=>v+r-l,0)};
 case 'INTERVAL_MAX_OVERLAP':return {maximum:Math.max(0,...ss.map(v=>v[2]))};
 case 'INTERVAL_OVERLAP_SEGMENTS':return {segments:ss.filter(v=>v[2]>=2).map(v=>v.slice(0,2))};
 case 'INTERVAL_DEPTH_PROFILE':return {segments:ss};
 case 'INTERVAL_OVERLAP_PAIRS':return {count:ids.flatMap(i=>ids.filter(j=>j>i&&a[i][0]<a[j][1]&&a[j][0]<a[i][1])).length};
 case 'INTERVAL_DISJOINT_PAIRS':return {count:ids.flatMap(i=>ids.filter(j=>j>i&&(a[i][1]<=a[j][0]||a[j][1]<=a[i][0]))).length};
 case 'INTERVAL_CONTAINMENT_PAIRS':return {pairs:ids.flatMap(i=>ids.filter(j=>i!==j&&a[i][0]<=a[j][0]&&a[j][1]<=a[i][1]).map(j=>[i,j]))};
 case 'INTERVAL_ACTIVE_INDICES':return {indices:ids.filter(i=>a[i][0]<=t&&t<a[i][1])};
 case 'INTERVAL_ACTIVE_COUNT':return {count:depth(a,t)};
 case 'INTERVAL_NEXT_START':return {start:a.map(p=>p[0]).filter(v=>v>=t).sort((a,b)=>a-b)[0]??null};
 case 'INTERVAL_NEXT_END':return {end:a.map(p=>p[1]).filter(v=>v>=t).sort((a,b)=>a-b)[0]??null};
 case 'INTERVAL_WINDOW_GAPS':return {gaps:gaps(a,s,e)};
 case 'INTERVAL_WINDOW_COVERAGE':return {length:seq(e-s).filter(k=>depth(a,s+k)>0).length};
 case 'INTERVAL_LONGEST_GAP':{const g=gaps(a,s,e);return {gap:g.reduce((best,p)=>p[1]-p[0]>best[1]-best[0]?p:best,[s,s])};}
 case 'INTERVAL_EARLIEST_FINISH':return {index:ids.sort((i,j)=>a[i][1]-a[j][1]||a[i][0]-a[j][0]||i-j)[0]??null};
 case 'INTERVAL_LATEST_START':return {index:ids.sort((i,j)=>a[j][0]-a[i][0]||i-j)[0]??null};
 case 'INTERVAL_MAX_DISJOINT':return {maximum:Math.max(...selected(a).map(v=>v.length))};
 case 'INTERVAL_ROOM_PARTITION':return {minimum:Math.max(0,...ss.map(v=>v[2]))};
 case 'INTERVAL_SET_INTERSECTION':return {intervals:setOp(a,b,'intersection')};
 case 'INTERVAL_SET_DIFFERENCE':return {intervals:setOp(a,b,'difference')};
 case 'INTERVAL_SET_SYMMETRIC':return {intervals:setOp(a,b,'symmetric')};
 case 'INTERVAL_DEPTH_HISTOGRAM':{const map=new Map();for(const [l,r,d]of ss)if(d>0)map.set(d,(map.get(d)??0)+r-l);return {histogram:[...map].sort((a,b)=>a[0]-b[0])};}
 case 'INTERVAL_EXCLUSIVE_LENGTH':return {length:ss.filter(v=>v[2]===1).reduce((sum,[l,r])=>sum+r-l,0)};
 default:throw Error('missing interval reference '+tag);
 }
}
function verify(tag,input,actual,expected){if(tag==='INTERVAL_MAX_DISJOINT'){assert.ok(Array.isArray(actual.indices));assert.equal(new Set(actual.indices).size,actual.indices.length);assert.equal(actual.indices.length,expected.maximum);const a=input.intervals;for(const i of actual.indices){assert.ok(Number.isInteger(i)&&i>=0&&i<a.length);for(const j of actual.indices)if(i!==j)assert.ok(a[i][1]<=a[j][0]||a[j][1]<=a[i][0]);}return;}
 if(tag==='INTERVAL_ROOM_PARTITION'){const a=input.intervals;assert.equal(actual.roomCount,expected.minimum);assert.equal(actual.rooms?.length,a.length);for(let i=0;i<a.length;i++){assert.ok(Number.isInteger(actual.rooms[i])&&actual.rooms[i]>=0&&actual.rooms[i]<actual.roomCount);for(let j=i+1;j<a.length;j++)if(a[i][0]<a[j][1]&&a[j][0]<a[i][1])assert.notEqual(actual.rooms[i],actual.rooms[j]);}return;}
 assert.deepStrictEqual(actual,expected);
}
export const runInterval238Bank=options=>runBatchBank({name:'AXIOMA integer half-open intervals 651-675',prefix:'CONTROL',start:651,tags,input,reference,verify,...options});
