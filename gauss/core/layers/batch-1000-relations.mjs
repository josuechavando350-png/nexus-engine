// Arbitrary finite binary relations, not restricted to posets or DAGs.
import {object,arr,int,freeze,entries,range} from './batch-1000-common.mjs';
function relation(x){object(x,['size','pairs']);const n=int(x.size,'size',1,10),pairs=arr(x.pairs,'pairs',0,n*n);let a=Array.from({length:n},()=>Array(n).fill(false)),seen=new Set();for(const[k,p]of pairs.entries()){arr(p,`pairs[${k}]`,2,2);const i=int(p[0],'source',0,n-1),j=int(p[1],'target',0,n-1),key=`${i},${j}`;if(seen.has(key))throw new TypeError('repeated relation pair');seen.add(key);a[i][j]=true;}return a;}
const sample={size:4,pairs:[[0,1],[1,2],[2,0],[2,3]]};
function from(a){const pairs=[];for(let i=0;i<a.length;i++)for(let j=0;j<a.length;j++)if(a[i][j])pairs.push([i,j]);return pairs;}
const output=a=>freeze({pairs:from(a)});
const pair=x=>{object(x,['size','left','right']);return [relation({size:x.size,pairs:x.left}),relation({size:x.size,pairs:x.right})];};
const one=x=>{object(x,['size','pairs','power']);return [relation({size:x.size,pairs:x.pairs}),int(x.power,'power',0,12)];};
function mul(a,b){const n=a.length,r=Array.from({length:n},()=>Array(n).fill(false));for(let i=0;i<n;i++)for(let k=0;k<n;k++)if(a[i][k])for(let j=0;j<n;j++)r[i][j] ||= b[k][j];return r;}
const trans=a=>a.every((row,i)=>row.every((v,j)=>!v||a[j].every((z,k)=>!z||a[i][k])));
const reflex=a=>a.every((row,i)=>row[i]);
const sym=a=>a.every((row,i)=>row.every((v,j)=>v===a[j][i]));
const anti=a=>a.every((row,i)=>row.every((v,j)=>i===j||!v||!a[j][i]));
const functional=a=>a.every(row=>row.filter(Boolean).length<=1);
export function relationDomain(x){const a=relation(x);return freeze({elements:range(a.length).filter(i=>a[i].some(Boolean))});}
export function relationRange(x){const a=relation(x);return freeze({elements:range(a.length).filter(j=>a.some(row=>row[j]))});}
export function relationConverse(x){const a=relation(x);return output(a.map((_,i)=>a.map(row=>row[i])));}
export function relationComplement(x){return output(relation(x).map(row=>row.map(v=>!v)));}
export function relationIdentity(x){const n=relation(x).length;return output(Array.from({length:n},(_,i)=>range(n).map(j=>i===j)));}
export function relationReflexiveClosure(x){return output(relation(x).map((row,i)=>row.map((v,j)=>v||i===j)));}
export function relationSymmetricClosure(x){const a=relation(x);return output(a.map((row,i)=>row.map((v,j)=>v||a[j][i])));}
export function relationTransitiveClosure(x){const a=relation(x);for(let k=0;k<a.length;k++)for(let i=0;i<a.length;i++)for(let j=0;j<a.length;j++)a[i][j] ||= a[i][k]&&a[k][j];return output(a);}
export function relationComposition(x){const[a,b]=pair(x);return output(mul(a,b));}
export function relationPower(x){let[a,k]=one(x),r=Array.from({length:a.length},(_,i)=>range(a.length).map(j=>i===j));while(k){if(k%2)r=mul(r,a);k=Math.floor(k/2);if(k)a=mul(a,a);}return output(r);}
export function relationUnion(x){const[a,b]=pair(x);return output(a.map((row,i)=>row.map((v,j)=>v||b[i][j])));}
export function relationIntersection(x){const[a,b]=pair(x);return output(a.map((row,i)=>row.map((v,j)=>v&&b[i][j])));}
export function relationDifference(x){const[a,b]=pair(x);return output(a.map((row,i)=>row.map((v,j)=>v&&!b[i][j])));}
export function relationSymmetricDifference(x){const[a,b]=pair(x);return output(a.map((row,i)=>row.map((v,j)=>v!==b[i][j])));}
export function relationReflexive(x){return freeze({reflexive:reflex(relation(x))});}
export function relationIrreflexive(x){const a=relation(x);return freeze({irreflexive:a.every((row,i)=>!row[i])});}
export function relationSymmetric(x){return freeze({symmetric:sym(relation(x))});}
export function relationAntisymmetric(x){return freeze({antisymmetric:anti(relation(x))});}
export function relationTransitive(x){return freeze({transitive:trans(relation(x))});}
export function relationEquivalence(x){const a=relation(x);return freeze({equivalence:reflex(a)&&sym(a)&&trans(a)});}
export function relationEquivalenceClasses(x){const a=relation(x);if(!reflex(a)||!sym(a)||!trans(a))throw new TypeError('equivalence classes require equivalence relation');const seen=new Set(),classes=[];for(let i=0;i<a.length;i++)if(!seen.has(i)){const c=range(a.length).filter(j=>a[i][j]);c.forEach(j=>seen.add(j));classes.push(c);}return freeze({classes});}
export function relationFunctional(x){return freeze({rightUnique:functional(relation(x))});}
export function relationInjective(x){const a=relation(x);return freeze({leftUnique:range(a.length).every(j=>a.filter(row=>row[j]).length<=1)});}
export function relationLeftTotal(x){return freeze({leftTotal:relation(x).every(row=>row.some(Boolean))});}
export function relationRightTotal(x){const a=relation(x);return freeze({rightTotal:range(a.length).every(j=>a.some(row=>row[j]))});}
const extra={size:4,left:sample.pairs,right:[[0,1],[1,2],[0,0]]};
const equivalence={size:4,pairs:[[0,0],[1,1],[2,2],[3,3],[0,1],[1,0],[2,3],[3,2]]};
const specs=[
 ['DOMAIN','Domain of arbitrary binary relation',relationDomain,sample],
 ['RANGE','Range of arbitrary binary relation',relationRange,sample],
 ['CONVERSE','Transpose or converse relation',relationConverse,sample],
 ['COMPLEMENT','Complement inside the square carrier',relationComplement,sample],
 ['IDENTITY','Diagonal identity relation on the carrier',relationIdentity,sample],
 ['REFLEXIVE_CLOSURE','Smallest reflexive relation containing input',relationReflexiveClosure,sample],
 ['SYMMETRIC_CLOSURE','Smallest symmetric relation containing input',relationSymmetricClosure,sample],
 ['TRANSITIVE_CLOSURE','Reachability relation including nontrivial cycles',relationTransitiveClosure,sample],
 ['COMPOSITION','Existential Boolean relational composition',relationComposition,extra],
 ['POWER','Exact k-fold relational composition by repeated squaring',relationPower,{...sample,power:4}],
 ['UNION','Set union of ordered relation pairs',relationUnion,extra],
 ['INTERSECTION','Set intersection of ordered relation pairs',relationIntersection,extra],
 ['DIFFERENCE','Directional set difference of relation pairs',relationDifference,extra],
 ['SYMMETRIC_DIFFERENCE','Exclusive-or of relation pairs',relationSymmetricDifference,extra],
 ['IS_REFLEXIVE','Reflexive predicate over a binary relation',relationReflexive,sample],
 ['IS_IRREFLEXIVE','Irreflexive predicate over a binary relation',relationIrreflexive,sample],
 ['IS_SYMMETRIC','Symmetric predicate over a binary relation',relationSymmetric,sample],
 ['IS_ANTISYMMETRIC','Antisymmetric predicate over a binary relation',relationAntisymmetric,sample],
 ['IS_TRANSITIVE','Transitive predicate over a binary relation',relationTransitive,sample],
 ['IS_EQUIVALENCE','Equivalence-relation predicate',relationEquivalence,equivalence],
 ['EQUIVALENCE_CLASSES','Canonical equivalence classes of a validated relation',relationEquivalenceClasses,equivalence],
 ['RIGHT_UNIQUE','Functional or right-unique relation predicate',relationFunctional,sample],
 ['LEFT_UNIQUE','Left-unique relation predicate',relationInjective,sample],
 ['LEFT_TOTAL','Left-total relation predicate',relationLeftTotal,sample],
 ['RIGHT_TOTAL','Right-total relation predicate',relationRightTotal,sample],
];
export const FINITE_RELATIONS_900=entries(specs,'CS.FINITE_RELATIONS','COMPUTER_SCIENCE',876);
