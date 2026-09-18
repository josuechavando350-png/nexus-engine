/* Independent rooted-tree references: component cuts, direct vertex paths and sorted adjacency walks. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['TREE_PARENTS','TREE_DEPTHS','TREE_CHILDREN','TREE_BFS','TREE_PREORDER','TREE_POSTORDER','TREE_SUBTREE_SIZES','TREE_LEAVES','TREE_LEAF_COUNT','TREE_HEIGHT','TREE_LEVELS','TREE_SUBTREE_VERTICES','TREE_LCA','TREE_DISTANCE','TREE_PATH','TREE_KTH_ANCESTOR','TREE_ANCESTOR_CHECK','TREE_DEGREES','TREE_DEGREE_HISTOGRAM','TREE_MAX_BRANCH','TREE_CENTERS','TREE_CENTROIDS','TREE_DIAMETER','TREE_ROOT_LEAF_PATHS','TREE_SUBTREE_SUMS'];
const vertexTags=new Set(['TREE_SUBTREE_VERTICES','TREE_KTH_ANCESTOR']);
const pairTags=new Set(['TREE_LCA','TREE_DISTANCE','TREE_PATH','TREE_ANCESTOR_CHECK']);
function input(tag,i,r){const n=1+i%12,edges=seq(n-1).map(j=>{const v=j+1,p=i%9===0?0:i%9===1?v-1:r(v);return r(2)?[v,p]:[p,v];});for(let j=edges.length-1;j>0;j--){const k=r(j+1);[edges[j],edges[k]]=[edges[k],edges[j]];}const tree={n,root:r(n),edges};
 if(pairTags.has(tag))return {tree,a:r(n),b:r(n)};
 if(vertexTags.has(tag))return tag==='TREE_KTH_ANCESTOR'?{tree,vertex:r(n),k:i%7===0?n:r(n+1)}:{tree,vertex:r(n)};
 if(tag==='TREE_SUBTREE_SUMS')return {tree,values:seq(n).map(()=>i%6===0?0:r(401)-200)};
 return tree;}
function parsed(tree){const n=tree.n,adj=seq(n).map(()=>[]);for(const [a,b] of tree.edges){adj[a].push(b);adj[b].push(a);}adj.forEach(row=>row.sort((a,b)=>a-b));const parent=Array(n).fill(-1),depth=Array(n).fill(-1),queue=[tree.root];depth[tree.root]=0;for(let p=0;p<queue.length;p++)for(const v of adj[queue[p]])if(depth[v]<0){depth[v]=depth[queue[p]]+1;parent[v]=queue[p];queue.push(v);}const children=seq(n).map(i=>adj[i].filter(v=>v!==parent[i]));const pre=[],post=[];const visit=u=>{pre.push(u);for(const v of children[u])visit(v);post.push(u);};visit(tree.root);
 const ancestors=v=>{const arr=[];for(let t=v;t!==-1;t=parent[t])arr.push(t);return arr;};
 const path=(a,b)=>{const left=ancestors(a),right=ancestors(b),p=left.find(v=>right.includes(v));return [...left.slice(0,left.indexOf(p)),p,...right.slice(0,right.indexOf(p)).reverse()];};
 const distances=v=>{const d=Array(n).fill(-1);d[v]=0;const q=[v];for(let k=0;k<q.length;k++)for(const u of adj[q[k]])if(d[u]<0){d[u]=d[q[k]]+1;q.push(u);}return d;};
 return {n,adj,parent,depth,queue,children,pre,post,ancestors,path,distances};}
function reference(tag,x){const t=parsed(x.tree??x),{n,adj,parent,depth,queue,children,pre,post,ancestors,path,distances}=t,vertices=seq(n),leaves=vertices.filter(i=>children[i].length===0),desc=v=>pre.filter(i=>ancestors(i).includes(v));
 switch(tag){
 case 'TREE_PARENTS':return {parents:parent};
 case 'TREE_DEPTHS':return {depths:depth};
 case 'TREE_CHILDREN':return {children};
 case 'TREE_BFS':return {order:queue};
 case 'TREE_PREORDER':return {order:pre};
 case 'TREE_POSTORDER':return {order:post};
 case 'TREE_SUBTREE_SIZES':return {sizes:vertices.map(v=>desc(v).length)};
 case 'TREE_LEAVES':return {vertices:leaves};
 case 'TREE_LEAF_COUNT':return {count:leaves.length};
 case 'TREE_HEIGHT':return {height:Math.max(...depth)};
 case 'TREE_LEVELS':return {levels:seq(Math.max(...depth)+1).map(d=>vertices.filter(i=>depth[i]===d))};
 case 'TREE_SUBTREE_VERTICES':return {vertices:desc(x.vertex)};
 case 'TREE_LCA':return {vertex:ancestors(x.a).find(v=>ancestors(x.b).includes(v))};
 case 'TREE_DISTANCE':return {distance:path(x.a,x.b).length-1};
 case 'TREE_PATH':return {vertices:path(x.a,x.b)};
 case 'TREE_KTH_ANCESTOR':return {vertex:ancestors(x.vertex)[x.k]??null};
 case 'TREE_ANCESTOR_CHECK':return {isAncestor:ancestors(x.b).includes(x.a)};
 case 'TREE_DEGREES':return {degrees:adj.map(r=>r.length)};
 case 'TREE_DEGREE_HISTOGRAM':return {counts:seq(n).map(k=>adj.filter(r=>r.length===k).length)};
 case 'TREE_MAX_BRANCH':{const max=Math.max(...children.map(c=>c.length));return {maximum:max,vertices:vertices.filter(v=>children[v].length===max)};}
 case 'TREE_CENTERS':{const ecc=vertices.map(v=>Math.max(...distances(v))),radius=Math.min(...ecc);return {radius,vertices:vertices.filter(v=>ecc[v]===radius)};}
 case 'TREE_CENTROIDS':{const valid=vertices.filter(removed=>{const seen=new Set([removed]);let largest=0;for(const start of vertices)if(!seen.has(start)){let size=0,stack=[start];seen.add(start);while(stack.length){const v=stack.pop();size++;for(const u of adj[v])if(!seen.has(u)){seen.add(u);stack.push(u);}}largest=Math.max(largest,size);}return 2*largest<=n;});return {vertices:valid};}
 case 'TREE_DIAMETER':return {length:Math.max(...vertices.flatMap(v=>distances(v)))};
 case 'TREE_ROOT_LEAF_PATHS':return {paths:leaves.map(v=>ancestors(v).reverse())};
 case 'TREE_SUBTREE_SUMS':return {subtreeSums:vertices.map(v=>String(desc(v).reduce((s,j)=>s+BigInt(x.values[j]),0n)))};
 default:throw Error(`missing independent rooted-tree reference: ${tag}`);
 }
}
function verify(tag,input,actual,expected){if(tag==='TREE_DIAMETER'){const tree=input,parsedTree=parsed(tree);assert.equal(actual.length,expected.length);assert.ok(Number.isInteger(actual.u)&&actual.u>=0&&actual.u<tree.n);assert.ok(Number.isInteger(actual.v)&&actual.v>=0&&actual.v<tree.n);assert.equal(parsedTree.path(actual.u,actual.v).length-1,actual.length);return;}assert.deepStrictEqual(actual,expected);}
export const runRootedTree238Bank=options=>runBatchBank({name:'AXIOMA rooted trees 626-650',prefix:'CS',start:626,tags,input,reference,verify,...options});
