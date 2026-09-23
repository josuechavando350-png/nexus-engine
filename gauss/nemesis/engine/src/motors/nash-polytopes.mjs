import {object,array,rational,add,sub,mul,div,cmp,fmt,ZERO,ONE,integer} from './shared.mjs';
const dot=(a,b)=>a.reduce((s,v,i)=>add(s,mul(v,b[i])),ZERO);
function rref(equations,n){
 const M=equations.map(r=>r.map(v=>v)),pivots=[];let row=0;
 for(let col=0;col<n&&row<M.length;col++){
  const at=M.findIndex((r,i)=>i>=row&&r[col][0]!==0n);if(at<0)continue;
  [M[row],M[at]]=[M[at],M[row]];const d=M[row][col];M[row]=M[row].map(v=>div(v,d));
  for(let i=0;i<M.length;i++)if(i!==row&&M[i][col][0]!==0n){const f=M[i][col];M[i]=M[i].map((v,j)=>sub(v,mul(f,M[row][j])));}
  pivots.push(col);row++;
 }
 if(M.some(r=>r.slice(0,n).every(v=>v[0]===0n)&&r[n][0]!==0n))return null;
 return {rows:M.slice(0,row),pivots};
}
function* combinations(n,k,start=0,chosen=[]){if(k===0){yield chosen;return;}for(let j=start;j<=n-k;j++)yield* combinations(n,k-1,j+1,[...chosen,j]);}
function vertices(equalities,inequalities,n,budget){
 const reduced=rref(equalities,n);if(!reduced)return [];
 const needed=n-reduced.pivots.length,found=new Map();
 for(const active of combinations(inequalities.length,needed)){
  if(++budget.used>budget.max)throw new RangeError('Nash vertex enumeration budget exceeded; no partial completeness report');
  const solved=rref([...reduced.rows,...active.map(i=>inequalities[i])],n);if(!solved||solved.pivots.length!==n)continue;
  const point=Array(n).fill(ZERO);solved.pivots.forEach((p,i)=>point[p]=solved.rows[i][n]);
  if(inequalities.some(r=>cmp(dot(r.slice(0,n),point),r[n])>0))continue;
  found.set(point.map(fmt).join(','),point);
 }
 return [...found.values()];
}
const support=(mask,n)=>Array.from({length:n},(_,i)=>i).filter(i=>mask&(1<<i));
/** All equilibria as a finite union of products of rational convex hulls. Degeneracy is retained. */
export function enumerateBimatrixEquilibriumPolytopes(input){
 object(input,'Nash polytope enumeration',['rowPayoffs','columnPayoffs','maxVertexSystems'],['rowPayoffs','columnPayoffs']);
 const rows=array(input.rowPayoffs,'rowPayoffs',2,5),m=rows.length,n=array(rows[0],'payoff row',2,5).length;
 const parse=(raw,label)=>array(raw,label,m,m).map(r=>array(r,'payoff row',n,n).map(v=>rational(v,'payoff'))),A=parse(rows,'rowPayoffs'),B=parse(input.columnPayoffs,'columnPayoffs');
 const budget={used:0,max:integer(input.maxVertexSystems??200000,'maxVertexSystems',1,1000000)},families=[],seen=new Set();
 for(let im=1;im<(1<<m);im++)for(let jm=1;jm<(1<<n);jm++){
  const I=support(im,m),J=support(jm,n);
  // q makes every row in I indifferent and optimal; q only uses columns in J.
  const eqQ=[[...J.map(()=>ONE),ONE],...I.slice(1).map(i=>[...J.map(j=>sub(A[i][j],A[I[0]][j])),ZERO])];
  const iqQ=[...J.map((_,k)=>[...J.map((__,j)=>j===k?[-1n,1n]:ZERO),ZERO]),...Array.from({length:m},(_,i)=>i).filter(i=>!I.includes(i)).map(i=>[...J.map(j=>sub(A[i][j],A[I[0]][j])),ZERO])];
  const q=vertices(eqQ,iqQ,J.length,budget);if(!q.length)continue;
  const eqP=[[...I.map(()=>ONE),ONE],...J.slice(1).map(j=>[...I.map(i=>sub(B[i][j],B[i][J[0]])),ZERO])];
  const iqP=[...I.map((_,k)=>[...I.map((__,i)=>i===k?[-1n,1n]:ZERO),ZERO]),...Array.from({length:n},(_,j)=>j).filter(j=>!J.includes(j)).map(j=>[...I.map(i=>sub(B[i][j],B[i][J[0]])),ZERO])];
  const p=vertices(eqP,iqP,I.length,budget);if(!p.length)continue;
  const expand=(vs,S,N)=>vs.map(v=>Array.from({length:N},(_,j)=>fmt(S.includes(j)?v[S.indexOf(j)]:ZERO))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const rowVertices=expand(p,I,m),columnVertices=expand(q,J,n),signature=JSON.stringify([rowVertices,columnVertices]);if(seen.has(signature))continue;seen.add(signature);
  families.push({rowSupport:I,columnSupport:J,rowVertices,columnVertices,containsContinuum:rowVertices.length>1||columnVertices.length>1});
 }
 return {domain:'EXACT_RATIONAL_BIMATRIX_EQUILIBRIUM_POLYTOPES',completeForInput:true,strategies:[m,n],families,supportPairsExamined:((1<<m)-1)*((1<<n)-1),vertexSystemsSolved:budget.used,interpretation:'union over families of convexHull(rowVertices) x convexHull(columnVertices); families may overlap; rational arithmetic'};
}
