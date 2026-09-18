import test from 'node:test';
import assert from 'node:assert/strict';
import {BATCH_400_ADDITIONS as all} from '../core/batch-400-additions.mjs';
import {EXACT_POLYNOMIAL_400 as P} from '../core/layers/batch-400-polynomial.mjs';
import {EXACT_MATRIX_400 as M} from '../core/layers/batch-400-matrix.mjs';
import {EXACT_GRAPHS_400 as G} from '../core/layers/batch-400-graphs.mjs';
import {EXACT_SEQUENCES_400 as S} from '../core/layers/batch-400-sequences.mjs';
let state=0x1985abcd;
const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
const r=(lo,hi)=>lo+rand()%(hi-lo+1);
const v=x=>({value:String(x)});
const coeff=x=>({coefficients:x.map(String)});
const norm=a=>{a=a.slice();while(a.length>1&&a.at(-1)===0)a.pop();return a;};
const eq=(a,b,ctx)=>assert.deepEqual(a,b,ctx);
function perms(a){return a.length?a.flatMap((x,i)=>perms(a.filter((_,j)=>j!==i)).map(t=>[x,...t])):[[]];}
function det(a){if(!a.length)return 1;return a[0].reduce((s,v,j)=>s+(j%2?-1:1)*v*det(a.slice(1).map(row=>row.filter((_,k)=>k!==j))),0);}
function matmul(a,b){return a.map(row=>b[0].map((_,j)=>row.reduce((s,v,k)=>s+v*b[k][j],0)));}
function graphOracle(input){const n=input.vertexCount,edges=input.edges.map(({from:a,to:b})=>[a,b]);const adj=Array.from({length:n},()=>Array(n).fill(0));for(const[a,b]of edges)adj[a][b]=adj[b][a]=1;const d=adj.map(row=>row.reduce((s,v)=>s+v,0));return {n,edges,adj,d};}
function masks(n){return Array.from({length:1<<n},(_,i)=>i);}
const vertices=(n,m)=>Array.from({length:n},(_,i)=>i).filter(i=>m>>i&1);
function conn(adj,mask){const vs=vertices(adj.length,mask);if(!vs.length)return false;const seen=new Set([vs[0]]),q=[vs[0]];for(const u of q)for(const w of vs)if(adj[u][w]&&!seen.has(w)){seen.add(w);q.push(w);}return seen.size===vs.length;}
function clique(adj,mask){const v=vertices(adj.length,mask);return v.every((u,i)=>v.slice(i+1).every(w=>adj[u][w]));}
const hist=x=>[...x].sort((a,b)=>a[0]-b[0]).map(([v,c])=>({value:String(v),count:String(c)}));
test('100 genuinely callable definitions, disjoint from prior 100, deterministic frozen JSON outputs',async()=>{
 assert.equal(all.length,100);assert.equal(new Set(all.map(x=>x.id)).size,100);assert.equal(new Set(all.map(x=>x.execute)).size,100);
 for(const [group,count] of [[P,25],[M,25],[G,25],[S,25]])assert.equal(group.length,count);
 for(const op of all){const got=op.execute(op.input);eq(got,op.execute(structuredClone(op.input)),op.id);assert(Object.isFrozen(got),op.id);assert.equal(JSON.stringify(got).includes('TODO'),false);}
});
test('25 polynomial operators agree with separate integer coefficient oracles on 100 deterministic polynomials',()=>{
 for(let z=0;z<100;z++){
  const a=Array.from({length:r(1,6)},()=>r(-4,4)),b=Array.from({length:r(1,5)},()=>r(-3,3)),at=r(-3,3),factor=r(-2,2),degree=r(0,6),places=r(0,4),exponent=r(0,4);
  const normed=norm(a),sum=a.reduce((s,x)=>s+x,0),evalp=(p,t)=>p.reduce((s,c,i)=>s+c*t**i,0);
  const g=(u,v)=>v?g(v,u%v):Math.abs(u);const content=a.reduce((s,c)=>g(s,c),0);
  const mul=(x,y)=>Array.from({length:x.length+y.length-1},(_,i)=>x.reduce((s,c,j)=>s+c*(y[i-j]??0),0));
  const o=[
   {x:{left:a,right:b},want:coeff(norm(Array.from({length:Math.max(a.length,b.length)},(_,i)=>(a[i]??0)+(b[i]??0))))},
   {x:{left:a,right:b},want:coeff(norm(Array.from({length:Math.max(a.length,b.length)},(_,i)=>(a[i]??0)-(b[i]??0))))},
   {x:{left:a,right:b},want:coeff(norm(mul(a,b)))},
   {x:{coefficients:a,at},want:v(evalp(a,at))},
   {x:{coefficients:a},want:coeff(norm(a.length===1?[0]:a.slice(1).map((t,i)=>t*(i+1))))},
   {x:{coefficients:a},want:coeff(norm(a.length<=2?[0]:a.slice(2).map((t,i)=>t*(i+1)*(i+2))))},
   {x:{coefficients:a},want:{degree:normed.length===1&&normed[0]===0?null:normed.length-1}},
   {x:{coefficients:a},want:v(normed.at(-1))},
   {x:{coefficients:a},want:v(content)},
   {x:{coefficients:a},want:coeff(content?norm(a.map(t=>t/content)):[0])},
   {x:{coefficients:a},want:coeff(norm([...normed].reverse()))},
   {x:{coefficients:a},want:coeff(norm(a.map((t,i)=>i%2?-t:t)))},
   {x:{coefficients:a},want:coeff(norm(a.map((t,i)=>i%2?0:t)))},
   {x:{coefficients:a},want:coeff(norm(a.map((t,i)=>i%2?t:0)))},
   {x:{coefficients:a,factor},want:coeff(norm(a.map(t=>t*factor)))},
   {x:{coefficients:a,factor},want:coeff(norm(a.map((t,i)=>t*factor**i)))},
   {x:{coefficients:a,places},want:coeff(norm([...Array(places).fill(0),...a]))},
   {x:{coefficients:a,degree},want:coeff(norm(a.slice(0,degree+1)))},
   {x:{coefficients:a,exponent},want:coeff(norm(Array.from({length:exponent},()=>a).reduce((q,t)=>mul(q,t),[1])))},
   {x:{left:a,right:b},want:null},
  ];
  // The composition oracle evaluates coefficients by independent binomial expansion.
  const composition=Array((a.length-1)*(b.length-1)+1).fill(0);
  for(let i=0;i<a.length;i++){let pow=[1];for(let j=0;j<i;j++)pow=mul(pow,b);for(let j=0;j<pow.length;j++)composition[j]+=a[i]*pow[j];}
  o[19].want=coeff(norm(composition));
  const trace=[];let acc=0;for(let j=a.length-1;j>=0;j--){acc=acc*at+a[j];trace.push(String(acc));}
  const c=norm(a);const quotient=Array(Math.max(1,c.length-1)).fill(0);let remainder=c[0];if(c.length>1){quotient[c.length-2]=c.at(-1);for(let j=c.length-3;j>=0;j--)quotient[j]=c[j+1]+at*quotient[j+1];remainder=c[0]+at*quotient[0];}
  o.push(
   {x:{coefficients:a,at},want:{accumulators:trace,result:String(acc)}},
   {x:{coefficients:a,root:at},want:{quotient:norm(quotient).map(String),remainder:String(remainder)}},
   {x:{coefficients:a,root:at},want:{isRoot:evalp(a,at)===0}},
   {x:{coefficients:a},want:v(sum)},
   {x:{coefficients:a},want:v(evalp(a,-1))},
  );
  assert.equal(o.length,25);
  for(let i=0;i<P.length;i++)eq(P[i].execute(o[i].x),o[i].want,`${P[i].id} case=${z}`);
 }
});
test('25 matrix operators: independent permutation determinants, permanents, minors and exact inverse identities',()=>{
 for(let z=0;z<90;z++){
  const n=r(1,4),a=Array.from({length:n},()=>Array.from({length:n},()=>r(-3,3))),b=Array.from({length:n},()=>Array.from({length:n},()=>r(-2,2))),o=[];
  const str=m=>({matrix:m.map(row=>row.map(String))});
  const tr=a[0].map((_,j)=>a.map(row=>row[j]));
  const d=det(a);const product=(u,v)=>u.reduce((s,x,i)=>s+x*v[i],0);
  const gcd=(u,v)=>v?gcd(v,u%v):Math.abs(u);
  const permsN=perms(Array.from({length:n},(_,i)=>i));
  const perm=permsN.reduce((s,p)=>s+p.reduce((v,j,i)=>v*a[i][j],1),0);
  const rank=(()=>{for(let k=n;k>=1;k--){for(const rows of masks(n).filter(x=>x.toString(2).replaceAll('0','').length===k))for(const cols of masks(n).filter(x=>x.toString(2).replaceAll('0','').length===k)){const ri=vertices(n,rows),ci=vertices(n,cols);if(det(ri.map(i=>ci.map(j=>a[i][j])))!==0)return k;}}return 0;})();
  const adj=n===1?[[1]]:a.map((_,i)=>a.map((_,j)=>(i+j)%2?-det(a.filter((_,t)=>t!==j).map(row=>row.filter((_,t)=>t!==i))):det(a.filter((_,t)=>t!==j).map(row=>row.filter((_,t)=>t!==i)))));
  o.push(
   {fn:0,x:{left:a,right:b},want:str(a.map((row,i)=>row.map((v,j)=>v+b[i][j])))},
   {fn:1,x:{left:a,right:b},want:str(a.map((row,i)=>row.map((v,j)=>v-b[i][j])))},
   {fn:2,x:{left:a,right:b},want:str(matmul(a,b))},
   {fn:3,x:{matrix:a},want:str(tr)},
   {fn:4,x:{matrix:a},want:v(a.reduce((s,row,i)=>s+row[i],0))},
   {fn:5,x:{matrix:a},want:v(d)},
   {fn:6,x:{matrix:a},want:v(perm)},
   {fn:7,x:{matrix:a},want:{rank}},
   {fn:9,x:{matrix:a},want:str(adj)},
   {fn:10,x:{matrix:a},want:str(matmul(tr,a))},
   {fn:11,x:{matrix:a},want:str(matmul(a,tr))},
   {fn:12,x:{left:[[1,2],[3,4]],right:[[0,1],[2,3]]},want:str([[0,1,0,2],[2,3,4,6],[0,3,0,4],[6,9,8,12]])},
   {fn:13,x:{left:a,right:b},want:str(a.map((row,i)=>row.map((v,j)=>v*b[i][j])))},
   {fn:14,x:{matrix:a,factor:2},want:str(a.map(row=>row.map(v=>2*v)))},
   {fn:15,x:{matrix:a,exponent:3},want:str(matmul(matmul(a,a),a))},
   {fn:16,x:{matrix:a},want:{values:a.map(row=>String(row.reduce((s,v)=>s+v,0)))}},
   {fn:17,x:{matrix:a},want:{values:tr.map(row=>String(row.reduce((s,v)=>s+v,0)))}},
   {fn:18,x:{matrix:a},want:{values:a.map(row=>String(row.reduce(gcd,0)))}},
   {fn:19,x:{matrix:a},want:{values:tr.map(row=>String(row.reduce(gcd,0)))}},
   {fn:20,x:{matrix:a},want:v(a.reduce((s,row,i)=>s*row[i],1))},
   {fn:21,x:{matrix:a},want:v(a.reduce((s,row,i)=>s+row[n-1-i],0))},
   {fn:22,x:{matrix:a},want:{symmetric:a.every((row,i)=>row.every((v,j)=>v===a[j][i]))}},
   {fn:23,x:{matrix:a},want:{skewSymmetric:a.every((row,i)=>row.every((v,j)=>v===-a[j][i]))}},
   {fn:24,x:{matrix:a},want:v(a.flat().reduce((s,v)=>s+v*v,0))},
  );
  for(const {fn,x,want}of o)eq(M[fn].execute(x),want,`${M[fn].id} case=${z}`);
  if(d){const inv=M[8].execute({matrix:a});for(let i=0;i<n;i++)for(let j=0;j<n;j++){let num=0n,den=1n;for(let k=0;k<n;k++){const p=BigInt(inv.numerators[k][j])*BigInt(a[i][k]),q=BigInt(inv.denominators[k][j]);num=num*q+p*den;den*=q;}assert.equal(num,BigInt(i===j)*den,'exact rational inverse identity');}}
  else assert.throws(()=>M[8].execute({matrix:a}),/singular/);
 }
});
test('25 graph operators agree with independent subset, path and 4-vertex enumeration on 110 seeded graphs',()=>{
 for(let z=0;z<110;z++){
  const n=r(1,6),edges=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(r(0,3)===0)edges.push({from:i,to:j});
  const base={vertexCount:n,edges}, {adj,d}=graphOracle(base),k=r(0,n),m=edges.length,subsets=masks(n);
  const pair=x=>x.reduce((s,t)=>s+t,0),gcd=(a,b)=>b?gcd(b,a%b):a;
  const edg=edges.map(x=>[x.from,x.to]);
  const independent=mask=>{const v=vertices(n,mask);return v.every((u,i)=>v.slice(i+1).every(w=>!adj[u][w]));};
  const cover=mask=>edg.every(([u,v])=>(mask>>u&1)||(mask>>v&1));
  const subK=predicate=>BigInt(subsets.filter(mask=>vertices(n,mask).length===k&&predicate(mask)).length);
  const ec=masks(m).filter(mask=>vertices(m,mask).length===k).filter(mask=>{const covered=new Set();for(let i=0;i<m;i++)if(mask>>i&1)for(const u of edg[i])covered.add(u);return covered.size===n;}).length;
  const maxInd=subsets.filter(mask=>independent(mask)&&Array.from({length:n},(_,i)=>i).filter(i=>!(mask>>i&1)).every(i=>!independent(mask|1<<i))).length;
  const maxClique=subsets.filter(mask=>mask&&clique(adj,mask)&&Array.from({length:n},(_,i)=>i).filter(i=>!(mask>>i&1)).every(i=>!clique(adj,mask|1<<i))).length;
  let cycles=0,induced=0,clique4=0;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let u=j+1;u<n;u++)for(let v=u+1;v<n;v++){
   const vs=[i,j,u,v],check=p=>p.every((a,t)=>adj[a][p[(t+1)%4]]===1);
   cycles+=Number(check([i,j,u,v]))+Number(check([i,j,v,u]))+Number(check([i,u,j,v]));
   const degrees=vs.map(t=>vs.reduce((s,w)=>s+adj[t][w],0));if(degrees.every(t=>t===2))induced++;
   if(vs.every((t,h)=>vs.slice(h+1).every(w=>adj[t][w])))clique4++;
  }
  let wedges=0,open=0;for(let j=0;j<n;j++)for(let i=0;i<n;i++)for(let u=i+1;u<n;u++)if(adj[j][i]&&adj[j][u]){wedges++;if(!adj[i][u])open++;}
  const den=n*(n-1)/2,g=den?gcd(m,den):1;
  const incidence=Array.from({length:n},(_,u)=>edg.map(([a,b])=>u===a?-1:u===b?1:0));
  const complement=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(!adj[i][j])complement.push({from:i,to:j});
  const line=[];for(let i=0;i<m;i++)for(let j=i+1;j<m;j++)if(edg[i].some(u=>edg[j].includes(u)))line.push({from:i,to:j});
  const dist=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?0:adj[i][j]?1:Infinity));
  for(let pivot=0;pivot<n;pivot++)for(let i=0;i<n;i++)for(let j=0;j<n;j++)dist[i][j]=Math.min(dist[i][j],dist[i][pivot]+dist[pivot][j]);
  const source=r(0,n-1),counts=Array(n).fill(0n);counts[source]=1n;
  const visit=(u,path)=>{for(let w=0;w<n;w++)if(adj[u][w]&&!path.includes(w)){if(path.length===dist[source][w])counts[w]++;visit(w,[...path,w]);}};
  visit(source,[source]);
  let closed=0n;const walks=(u,v,len)=>{if(!len)return BigInt(u===v);let c=0n;for(let w=0;w<n;w++)if(adj[u][w])c+=walks(w,v,len-1);return c;};for(let i=0;i<n;i++)closed+=walks(i,i,4);
  const expected=[
   {degrees:d},
   {counts:Array.from({length:n},(_,i)=>d.filter(v=>v===i).length)},
   {vertices:d.flatMap((v,i)=>v===0?[i]:[])},
   {vertices:d.flatMap((v,i)=>v===1?[i]:[])},
   {numerator:String(m/g),denominator:String(den?den/g:1)},
   v(subK(mask=>conn(adj,mask))),
   v(subK(independent)),
   v(subK(cover)),
   v(ec),
   v(maxInd),
   v(maxClique),
   v(cycles),
   v(induced),
   v(clique4),
   v(wedges),
   v(open),
   v(d.reduce((s,t)=>s+t*t,0)),
   v(edg.reduce((s,[i,j])=>s+d[i]*d[j],0)),
   {matrix:adj},
   {matrix:incidence},
   {edges:complement},
   {vertexCount:m,edges:line},
   {distances:dist[source].map(t=>Number.isFinite(t)?t:-1),pathCounts:counts.map(String)},
   dist.some(row=>row.some(t=>!Number.isFinite(t)))?{connected:false,value:null}:{connected:true,value:String(dist.reduce((s,row,i)=>s+row.reduce((q,x,j)=>q+(i<j?x:0),0),0))},
   v(closed),
  ];
  const inputs=G.map((op,i)=>i>=5&&i<=8?{...base,k}:i===22?{...base,source}:i===24?{...base,length:4}:base);
  assert.equal(expected.length,25);
  for(let i=0;i<25;i++)eq(G[i].execute(inputs[i]),expected[i],`${G[i].id} graph=${z}`);
 }
});
test('25 sequence operators agree with independent complete subsequence and interval enumeration on 140 signed sequences',()=>{
 for(let z=0;z<140;z++){
  const n=r(0,8),a=Array.from({length:n},()=>r(-3,3)),t=r(-4,4),k=r(0,n),base={values:a};
  const subs=masks(n).map(mask=>{const indexes=vertices(n,mask),values=indexes.map(i=>a[i]);return {indexes,values,sum:values.reduce((s,v)=>s+v,0),xor:values.reduce((s,v)=>s^v,0)};});
  const ranges=[];for(let i=0;i<n;i++)for(let j=i;j<n;j++)ranges.push({start:i,end:j,values:a.slice(i,j+1),sum:a.slice(i,j+1).reduce((s,v)=>s+v,0)});
  const grouped=values=>hist([...values.reduce((map,value)=>map.set(value,(map.get(value)??0)+1),new Map())]);
  const pairs=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)pairs.push([a[i],a[j]]);
  const candidate=ranges.filter(x=>x.sum===t).sort((a,b)=>b.values.length-a.values.length||a.start-b.start||a.end-b.end)[0];
  const extrema=op=>ranges.reduce((best,x)=>!best||op(x.sum,best.sum)?x:best,null);
  const subseq=subs.filter(x=>x.values.every((v,i)=>!i||x.values[i-1]<v));
  const nondec=subs.filter(x=>x.values.every((v,i)=>!i||x.values[i-1]<=v));
  const max=(values)=>Math.max(0,...values.map(x=>x.values.length));
  const incLen=max(subseq),nondecLen=max(nondec);
  const distinct=new Set(subs.map(x=>JSON.stringify(x.values)));distinct.delete('[]');
  let alt=0,equal=0,pal=0,palLength=0,palStart=0,gcdOne=0;
  const gcd=(u,v)=>v?gcd(v,u%v):Math.abs(u);
  for(const x of ranges){
   if(x.values.every((v,i)=>i===0||v===x.values[0]))equal=Math.max(equal,x.values.length);
   if(x.values.every((v,i)=>i<2||(x.values[i]-x.values[i-1])*(x.values[i-1]-x.values[i-2])<0)&&x.values.every((v,i)=>i===0||v!==x.values[i-1]))alt=Math.max(alt,x.values.length);
   if(x.values.every((v,i)=>v===x.values[x.values.length-1-i])){pal++;if(x.values.length>palLength){palLength=x.values.length;palStart=x.start;}}
   if(x.values.reduce(gcd,0)===1)gcdOne++;
  }
  const ordered=[
   v(subs.filter(x=>x.sum===t).length),
   v(new Set(subs.map(x=>x.sum)).size),
   {histogram:grouped(subs.map(x=>x.sum))},
   v(subs.filter(x=>x.sum===t&&x.values.length===k).length),
   {histogram:grouped(subs.map(x=>x.values.reduce((s,v)=>s^v,0)))},
   {histogram:grouped(pairs.map(([u,v])=>u+v))},
   {histogram:grouped(pairs.map(([u,v])=>u*v))},
   v(ranges.filter(x=>x.sum===t).length),
   {witness:candidate?{start:candidate.start,end:candidate.end,length:candidate.values.length}:null},
   v(ranges.reduce((s,x)=>s+x.sum,0)),
   v(ranges.reduce((s,x)=>s+x.sum*x.sum,0)),
   {witness:(()=>{const w=extrema((u,v)=>u>v);return w?{value:String(w.sum),start:w.start,end:w.end}:null;})()},
   {witness:(()=>{const w=extrema((u,v)=>u<v);return w?{value:String(w.sum),start:w.start,end:w.end}:null;})()},
   v(pairs.filter(([u,v])=>u<v).length),
   v(pairs.filter(([u,v])=>u<=v).length),
   v(pairs.filter(([u,v])=>u>v).length),
   {length:incLen,count:String(subseq.filter(x=>x.values.length===incLen).length)},
   {length:nondecLen,count:String(nondec.filter(x=>x.values.length===nondecLen).length)},
   v(distinct.size),
   {length:alt},
   {length:equal},
   v(gcdOne),
   v(subseq.filter(x=>x.values.length===k).length),
   {start:palStart,length:palLength},
   v(pal),
  ];
  const inputs=S.map((op,i)=>[0,7,8].includes(i)?{...base,target:t}:i===3?{...base,k,target:t}:i===4?{values:a.map(x=>x+3)}:i===22?{...base,k}:base);
  // The XOR oracle must be evaluated on the same explicitly unsigned input.
  ordered[4]={histogram:grouped(masks(n).map(mask=>vertices(n,mask).reduce((v,j)=>v^(a[j]+3),0)))};
  // A length-zero subsequence is the unique LIS/LNDS of the empty sequence.
  assert.equal(ordered.length,25);
  for(let i=0;i<25;i++)eq(S[i].execute(inputs[i]),ordered[i],`${S[i].id} seq=${z}`);
 }
});
test('strict invalid-input checks, edge cases, runtime budgets, and non-mutating execution',()=>{
 for(const layer of all){assert.throws(()=>layer.execute({}),/expected|bounded|matrix/i,layer.id);const data=structuredClone(layer.input),snapshot=JSON.stringify(data);layer.execute(data);assert.equal(JSON.stringify(data),snapshot,layer.id);}
 assert.throws(()=>P[0].execute({left:[1],right:[2],extra:1}),/expected/);
 assert.throws(()=>P[18].execute({coefficients:[1,2],exponent:100000}),/bounded/);
 assert.throws(()=>M[0].execute({left:[[1,2]],right:[[1]]}),/dimensions/);
 assert.throws(()=>M[8].execute({matrix:[[1,2],[2,4]]}),/singular/);
 assert.throws(()=>G[0].execute({vertexCount:3,edges:[{from:0,to:1},{from:1,to:0}]}),/duplicate/);
 assert.throws(()=>G[8].execute({vertexCount:7,edges:Array.from({length:21},(_,i)=>{let k=0;for(let a=0;a<7;a++)for(let b=a+1;b<7;b++)if(k++===i)return {from:a,to:b};}),k:3}),/budget/);
 assert.throws(()=>S[4].execute({values:[-1]}),/unsigned/);
 assert.throws(()=>S[0].execute({values:Array(15).fill(1),target:0}),/bounded/);
});
test('offline 100-task fixture and previous-batch manifest have exact one-to-one disjoint coverage',async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-400-problem.json',import.meta.url)));
 const prior=JSON.parse(await readFile(new URL('../fixtures/prior-batch-id-manifest.json',import.meta.url)));
 assert.equal(fixture.tasks.length,100);assert.equal(prior.ids.length,100);
 const old=new Set(prior.ids),current=new Set();
 for(let i=0;i<100;i++){const task=fixture.tasks[i],op=all[i];assert.equal(task.layerId,op.id);assert.equal(task.taskId,op.id);eq(task.input,op.input);assert(!old.has(task.layerId),task.layerId);assert(!current.has(task.layerId),task.layerId);current.add(task.layerId);}
});
test('forged per-task result with recomputed task and report hashes is rejected by replay',async()=>{
 const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const {verifyBatch400Evidence}=await import('../scripts/verify-batch-400.mjs');
 const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-400-problem.json',import.meta.url)));
 const shaFor=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const results=fixture.tasks.map((task,index)=>{
  const definition=all[index],output=definition.execute(structuredClone(task.input));
  return {layerId:definition.id,domain:definition.domain,status:'EXECUTED',inputSha256:shaFor(task.input),output,outputSha256:shaFor(output)};
 });
 const unsigned={batch:fixture.batch,implemented:100,executed:100,failed:0,results};
 const report={...unsigned,reportSha256:shaFor(unsigned)};
 eq((await verifyBatch400Evidence(report)).status,'PASS');
 const sha256=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 for(const index of [0,24,25,49,50,74,75,99]){
  const fake=structuredClone(report);fake.results[index].output={...fake.results[index].output,forged:true};fake.results[index].outputSha256=sha256(fake.results[index].output);
  const {reportSha256,...unsigned}=fake;void reportSha256;fake.reportSha256=sha256(unsigned);
  await assert.rejects(verifyBatch400Evidence(fake),/replay differs/,`forgery accepted for ${index}`);
 }
});
test('edge and budget suite: zero polynomial, singleton graph, sparse rectangular matrices, dense 12-vertex graph',()=>{
 eq(P[6].execute({coefficients:[0,0,0]}),{degree:null});
 eq(P[10].execute({coefficients:[1,2,0]}),{coefficients:['2','1']});
 eq(G[4].execute({vertexCount:1,edges:[]}),{numerator:'0',denominator:'1'});
 eq(G[9].execute({vertexCount:1,edges:[]}),{value:'1'});
 eq(M[3].execute({matrix:[[1,2,3],[4,5,6]]}),{matrix:[['1','4'],['2','5'],['3','6']]});
 const edges=[];for(let u=0;u<12;u++)for(let v=u+1;v<12;v++)edges.push({from:u,to:v});
 eq(G[10].execute({vertexCount:12,edges}),{value:'1'});
 eq(G[13].execute({vertexCount:12,edges}),{value:'495'});
 eq(S[0].execute({values:Array(14).fill(0),target:0}),{value:'16384'});
 eq(S[2].execute({values:Array(14).fill(0)}),{histogram:[{value:'0',count:'16384'}]});
});
