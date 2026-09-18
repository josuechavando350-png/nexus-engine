/* AXIOMA: independent path reachability, all subsets, all topological permutations and incidence recurrence. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['POSET_TRANSITIVE_CLOSURE','POSET_HASSE_COVER','POSET_COMPARABLE_PAIRS','POSET_INCOMPARABLE_PAIRS','POSET_MINIMAL_ELEMENTS','POSET_MAXIMAL_ELEMENTS','POSET_LEAST','POSET_GREATEST','POSET_HEIGHT','POSET_WIDTH','POSET_CHAIN_COUNT','POSET_ANTICHAIN_COUNT','POSET_IDEAL_COUNT','POSET_ALL_IDEALS','POSET_LINEAR_EXTENSIONS','POSET_LEX_MIN_EXTENSION','POSET_LEX_MAX_EXTENSION','POSET_RANK_LEVELS','POSET_CORANK_LEVELS','POSET_PRINCIPAL_IDEAL','POSET_PRINCIPAL_FILTER','POSET_INTERVAL','POSET_MOBIUS_INTERVAL','POSET_ZETA_TRANSFORM','POSET_MOBIUS_INVERSION'];
const subsets=a=>seq(2**a.length).map(m=>a.filter((_,i)=>m&(1<<i))),perms=a=>a.length?a.flatMap((v,i)=>perms(a.filter((_,k)=>i!==k)).map(t=>[v,...t])):[[]];
const cmp=(a,b)=>{for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;};
function input(tag,i,r){const n=1+i%4,order=seq(n).sort((a,b)=>r(2)?a-b:b-a),relations=[];for(let a=0;a<n;a++)for(let b=a+1;b<n;b++)if(r(3)!==0)relations.push([order[a],order[b]]);const poset={size:n,relations},x=tag==='POSET_PRINCIPAL_IDEAL'||tag==='POSET_PRINCIPAL_FILTER'?{poset,element:r(n)}:tag==='POSET_INTERVAL'||tag==='POSET_MOBIUS_INTERVAL'?{poset,a:r(n),b:r(n)}:tag==='POSET_ZETA_TRANSFORM'||tag==='POSET_MOBIUS_INVERSION'?{poset,values:seq(n).map(()=>r(9)-4)}:poset;return x;}
function reference(tag,x){const p=x.poset??x,n=p.size,v=seq(n),adj=v.map(i=>v.map(j=>i===j||p.relations.some(([a,b])=>a===i&&b===j)));for(let k=0;k<n;k++)for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(adj[i][k]&&adj[k][j])adj[i][j]=true;
 const down=i=>v.filter(j=>adj[j][i]),up=i=>v.filter(j=>adj[i][j]);
 const chain=s=>s.every((u,i)=>s.slice(i+1).every(w=>adj[u][w]||adj[w][u]));
 const antichain=s=>s.every((u,i)=>s.slice(i+1).every(w=>!adj[u][w]&&!adj[w][u]));
 const ideal=s=>s.every(u=>down(u).every(w=>s.includes(w)));
 const ss=subsets(v),orders=perms(v).filter(a=>a.every((u,i)=>a.slice(i+1).every(w=>!adj[w][u])));
 const longest=ss.filter(chain).sort((a,b)=>b.length-a.length||cmp(a,b))[0],width=ss.filter(antichain).sort((a,b)=>b.length-a.length||cmp(a,b))[0];
 function mobius(a,b){if(!adj[a][b])return 0; if(a===b)return 1;return -down(b).filter(u=>u!==b&&adj[a][u]).reduce((s,u)=>s+mobius(a,u),0);}
 function pathLen(a,reverse=false){const targets=reverse?down(a):up(a);return Math.max(0,...targets.filter(t=>t!==a).map(t=>1+pathLen(t,reverse)));}
 switch(tag){
 case 'POSET_TRANSITIVE_CLOSURE':return {matrix:adj};
 case 'POSET_HASSE_COVER':return {edges:v.flatMap(i=>v.filter(j=>i!==j&&adj[i][j]&&!v.some(k=>k!==i&&k!==j&&adj[i][k]&&adj[k][j])).map(j=>[i,j]))};
 case 'POSET_COMPARABLE_PAIRS':return {count:v.reduce((s,i)=>s+v.filter(j=>i<j&&(adj[i][j]||adj[j][i])).length,0)};
 case 'POSET_INCOMPARABLE_PAIRS':return {pairs:v.flatMap(i=>v.filter(j=>i<j&&!adj[i][j]&&!adj[j][i]).map(j=>[i,j]))};
 case 'POSET_MINIMAL_ELEMENTS':return {elements:v.filter(i=>down(i).length===1)};
 case 'POSET_MAXIMAL_ELEMENTS':return {elements:v.filter(i=>up(i).length===1)};
 case 'POSET_LEAST':return {element:v.find(i=>up(i).length===n)??null};
 case 'POSET_GREATEST':return {element:v.find(i=>down(i).length===n)??null};
 case 'POSET_HEIGHT':{const paths=perms(v).flatMap(order=>seq(n).flatMap(start=>seq(n-start).map(end=>order.slice(start,start+end+1)))).filter(s=>s.every((u,i)=>i===0||adj[s[i-1]][u]));const best=paths.sort((a,b)=>b.length-a.length||cmp(a,b))[0];return {length:longest.length,chain:best??[0]};}
 case 'POSET_WIDTH':return {width:width.length,antichain:width};
 case 'POSET_CHAIN_COUNT':return {count:String(ss.filter(chain).length)};
 case 'POSET_ANTICHAIN_COUNT':return {count:String(ss.filter(antichain).length)};
 case 'POSET_IDEAL_COUNT':return {count:String(ss.filter(ideal).length)};
 case 'POSET_ALL_IDEALS':return {ideals:ss.filter(ideal)};
 case 'POSET_LINEAR_EXTENSIONS':return {count:String(orders.length)};
 case 'POSET_LEX_MIN_EXTENSION':return {order:orders.slice().sort(cmp)[0]};
 case 'POSET_LEX_MAX_EXTENSION':return {order:orders.slice().sort(cmp).at(-1)};
 case 'POSET_RANK_LEVELS':return {levels:v.map(i=>pathLen(i,true))};
 case 'POSET_CORANK_LEVELS':return {levels:v.map(i=>pathLen(i,false))};
 case 'POSET_PRINCIPAL_IDEAL':return {elements:down(x.element)};
 case 'POSET_PRINCIPAL_FILTER':return {elements:up(x.element)};
 case 'POSET_INTERVAL':return {elements:v.filter(i=>adj[x.a][i]&&adj[i][x.b])};
 case 'POSET_MOBIUS_INTERVAL':return {value:String(mobius(x.a,x.b))};
 case 'POSET_ZETA_TRANSFORM':return {values:v.map(i=>String(down(i).reduce((s,j)=>s+x.values[j],0)))};
 case 'POSET_MOBIUS_INVERSION':return {values:v.map(i=>String(down(i).reduce((s,j)=>s+x.values[j]*mobius(j,i),0)))};
 default:throw Error('missing poset reference '+tag);
 }
}
function verify(tag,x,actual,expected){if(tag==='POSET_HEIGHT'){assert.equal(actual.length,expected.length);assert.equal(actual.chain.length,actual.length);const r=reference('POSET_TRANSITIVE_CLOSURE',x).matrix;assert.ok(actual.chain.every((v,i)=>i===0||r[actual.chain[i-1]][v]&&v!==actual.chain[i-1]));return;}assert.deepStrictEqual(actual,expected);}
export const runPoset438Bank=options=>runBatchBank({name:'AXIOMA finite posets independently enumerated 501–525',prefix:'MATH',start:501,tags,input,reference,verify,...options});
