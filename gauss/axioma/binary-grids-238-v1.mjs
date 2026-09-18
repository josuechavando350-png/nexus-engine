/* Independent bounded grid oracle: explicit cell sets, flood components, shortest-path relaxation and rectangle enumeration. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['GRID_ONES','GRID_ZEROS','GRID_ROW_COUNTS','GRID_COLUMN_COUNTS','GRID_COMPONENT_LABELS','GRID_COMPONENT_COUNT','GRID_COMPONENT_SIZES','GRID_LARGEST_COMPONENT','GRID_PERIMETER','GRID_HORIZONTAL_EDGES','GRID_VERTICAL_EDGES','GRID_HOLES','GRID_EULER','GRID_BOUNDING_BOX','GRID_SHORTEST_DISTANCE','GRID_SHORTEST_PATH','GRID_SHORTEST_PATH_COUNT','GRID_DISTANCE_FIELD','GRID_REACHABLE','GRID_ECCENTRICITY','GRID_MONOTONE_COUNT','GRID_MONOTONE_PATH','GRID_LARGEST_SQUARE','GRID_ALL_SQUARES','GRID_LARGEST_RECTANGLE'];
const routeTags=new Set(['GRID_SHORTEST_DISTANCE','GRID_SHORTEST_PATH','GRID_SHORTEST_PATH_COUNT','GRID_REACHABLE']);
const sourceTags=new Set(['GRID_DISTANCE_FIELD','GRID_ECCENTRICITY']);
const key=(r,c)=>`${r},${c}`;
function input(tag,i,r){const h=1+i%5,w=1+(Math.floor(i/5)%5),cells=seq(h).map(y=>seq(w).map(x=>i%11===0?0:i%11===1?1:i%11===2?(x+y)%2:i%11===3?+((x>0&&x<w-1)&&(y>0&&y<h-1)):r(2)));
 const start=[i%7===0?0:r(h),i%7===0?0:r(w)],end=[i%9===0?h-1:r(h),i%9===0?w-1:r(w)];if(routeTags.has(tag))return {cells,start,end};if(sourceTags.has(tag))return {cells,start};return {cells};}
const neighbors=(a,[i,j])=>[[i+1,j],[i-1,j],[i,j+1],[i,j-1]].filter(([r,c])=>r>=0&&c>=0&&r<a.length&&c<a[0].length);
const active=(a,i,j)=>a[i]?.[j]===1;
function components(a,value){const seen=new Set(),out=[],h=a.length,w=a[0].length;for(const i of seq(h))for(const j of seq(w))if(a[i][j]===value&&!seen.has(key(i,j))){const comp=[],stack=[[i,j]];seen.add(key(i,j));while(stack.length){const v=stack.pop();comp.push(v);for(const p of neighbors(a,v))if(a[p[0]][p[1]]===value&&!seen.has(key(...p))){seen.add(key(...p));stack.push(p);}}out.push(comp);}return out;}
function distances(a,s){const d=a.map(row=>row.map(()=>null));if(!active(a,...s))return d;d[s[0]][s[1]]=0;for(let step=0;step<a.length*a[0].length;step++){let changed=false;for(const i of seq(a.length))for(const j of seq(a[0].length))if(active(a,i,j)){for(const p of neighbors(a,[i,j]))if(active(a,...p)&&d[p[0]][p[1]]!==null&&(d[i][j]===null||d[p[0]][p[1]]+1<d[i][j])){d[i][j]=d[p[0]][p[1]]+1;changed=true;}}if(!changed)break;}return d;}
function monotone(a){const h=a.length,w=a[0].length,counts=a.map(row=>row.map(()=>0n));if(active(a,0,0))counts[0][0]=1n;for(const i of seq(h))for(const j of seq(w)){if(!active(a,i,j))continue;if(i)counts[i][j]+=counts[i-1][j];if(j)counts[i][j]+=counts[i][j-1];}return counts[h-1][w-1];}
function areaRect(a){let best=0,squares=0,side=0;for(const top of seq(a.length))for(let bottom=top;bottom<a.length;bottom++)for(const left of seq(a[0].length))for(let right=left;right<a[0].length;right++){let ok=true;for(let r=top;r<=bottom;r++)for(let c=left;c<=right;c++)if(!a[r][c])ok=false;if(ok){const h=bottom-top+1,w=right-left+1;best=Math.max(best,h*w);if(h===w){squares++;side=Math.max(side,h);}}}return {best,squares,side};}
function reference(tag,x){const a=x.cells,h=a.length,w=a[0].length,ones=components(a,1),coords=seq(h).flatMap(i=>seq(w).map(j=>[i,j])),on=coords.filter(v=>active(a,...v)),d=x.start?distances(a,x.start):null;
 switch(tag){
 case 'GRID_ONES':return {count:on.length};
 case 'GRID_ZEROS':return {count:h*w-on.length};
 case 'GRID_ROW_COUNTS':return {counts:a.map(row=>row.filter(Boolean).length)};
 case 'GRID_COLUMN_COUNTS':return {counts:seq(w).map(j=>a.filter(row=>row[j]).length)};
 case 'GRID_COMPONENT_LABELS':{const labels=a.map(row=>row.map(()=>-1));ones.forEach((group,i)=>group.forEach(([r,c])=>labels[r][c]=i));return {labels};}
 case 'GRID_COMPONENT_COUNT':return {count:ones.length};
 case 'GRID_COMPONENT_SIZES':return {sizes:ones.map(group=>group.length)};
 case 'GRID_LARGEST_COMPONENT':return {size:Math.max(0,...ones.map(group=>group.length))};
 case 'GRID_PERIMETER':return {perimeter:on.reduce((p,v)=>p+4-neighbors(a,v).filter(n=>active(a,...n)).length,0)};
 case 'GRID_HORIZONTAL_EDGES':return {count:on.filter(([i,j])=>active(a,i,j+1)).length};
 case 'GRID_VERTICAL_EDGES':return {count:on.filter(([i,j])=>active(a,i+1,j)).length};
 case 'GRID_HOLES':return {holes:components(a,0).filter(group=>group.every(([i,j])=>i>0&&j>0&&i<h-1&&j<w-1)).length};
 case 'GRID_EULER':return {characteristic:ones.length-components(a,0).filter(group=>group.every(([i,j])=>i>0&&j>0&&i<h-1&&j<w-1)).length};
 case 'GRID_BOUNDING_BOX':return {bounds:on.length?[Math.min(...on.map(v=>v[0])),Math.min(...on.map(v=>v[1])),Math.max(...on.map(v=>v[0])),Math.max(...on.map(v=>v[1]))]:null};
 case 'GRID_SHORTEST_DISTANCE':return {distance:d[x.end[0]][x.end[1]]};
 case 'GRID_SHORTEST_PATH':return {distance:d[x.end[0]][x.end[1]]};
 case 'GRID_SHORTEST_PATH_COUNT':{const level=d[x.end[0]][x.end[1]];if(level===null)return {count:'0'};const ways=a.map(row=>row.map(()=>0n));ways[x.start[0]][x.start[1]]=1n;for(let k=0;k<level;k++)for(const v of coords)if(d[v[0]][v[1]]===k)for(const n of neighbors(a,v))if(d[n[0]][n[1]]===k+1)ways[n[0]][n[1]]+=ways[v[0]][v[1]];return {count:String(ways[x.end[0]][x.end[1]])};}
 case 'GRID_DISTANCE_FIELD':return {distances:d};
 case 'GRID_REACHABLE':return {reachable:d[x.end[0]][x.end[1]]!==null};
 case 'GRID_ECCENTRICITY':{const reached=d.flat().filter(v=>v!==null);return {eccentricity:reached.length?Math.max(...reached):null};}
 case 'GRID_MONOTONE_COUNT':return {count:String(monotone(a))};
 case 'GRID_MONOTONE_PATH':return {exists:monotone(a)>0n};
 case 'GRID_LARGEST_SQUARE':return {side:areaRect(a).side};
 case 'GRID_ALL_SQUARES':return {count:areaRect(a).squares};
 case 'GRID_LARGEST_RECTANGLE':return {area:areaRect(a).best};
 default:throw Error(`missing grid oracle: ${tag}`);
 }
}
function verify(tag,x,actual,expected){if(tag==='GRID_SHORTEST_PATH'){const p=actual.path;if(expected.distance===null){assert.equal(p,null);return;}assert.ok(Array.isArray(p));assert.equal(p.length,expected.distance+1);assert.deepStrictEqual(p[0],x.start);assert.deepStrictEqual(p.at(-1),x.end);for(let i=0;i<p.length;i++){assert.ok(active(x.cells,...p[i]));if(i)assert.equal(Math.abs(p[i][0]-p[i-1][0])+Math.abs(p[i][1]-p[i-1][1]),1);}return;}
 if(tag==='GRID_MONOTONE_PATH'){const p=actual.path;if(!expected.exists){assert.equal(p,null);return;}assert.ok(Array.isArray(p));assert.deepStrictEqual(p[0],[0,0]);assert.deepStrictEqual(p.at(-1),[x.cells.length-1,x.cells[0].length-1]);assert.equal(p.length,x.cells.length+x.cells[0].length-1);for(let i=0;i<p.length;i++){assert.ok(active(x.cells,...p[i]));if(i)assert.ok((p[i][0]===p[i-1][0]+1&&p[i][1]===p[i-1][1])||(p[i][0]===p[i-1][0]&&p[i][1]===p[i-1][1]+1));}return;}
 assert.deepStrictEqual(actual,expected);}
export const runBinaryGrid238Bank=options=>runBatchBank({name:'AXIOMA binary grids 701-725',prefix:'CS',start:701,tags,input,reference,verify,...options});
