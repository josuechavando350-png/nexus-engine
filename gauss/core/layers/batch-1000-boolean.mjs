// Exact truth-table Boolean-function analysis, n <= 5 variables (2^5 states).
import {object,arr,int,freeze,entries,range} from './batch-1000-common.mjs';
function f(x){object(x,['n','table']);const n=int(x.n,'n',0,5),table=arr(x.table,'table',1<<n,1<<n).map((v,i)=>int(v,`table[${i}]`,0,1));return {n,t:table};}
const src={n:3,table:[0,1,1,0,1,0,0,1]};
const pop=m=>{let z=0;while(m){z+=m&1;m>>>=1;}return z;};
const place=(m,k,v)=>{let low=m&((1<<k)-1);return low|(v<<k)|((m>>k)<<(k+1));};
const c=x=>{object(x,['n','table','variable']);const v=f({n:x.n,table:x.table});return [v,int(x.variable,'variable',0,v.n-1)];};
const w=x=>{object(x,['n','table','mask']);const v=f({n:x.n,table:x.table});return [v,int(x.mask,'mask',0,(1<<v.n)-1)];};
const co=(z,k,v)=>Array.from({length:1<<(z.n-1)},(_,m)=>z.t[place(m,k,v)]);
const diff=(z,k)=>co(z,k,0).map((v,i)=>v^co(z,k,1)[i]);
function walsh(z){return range(1<<z.n).map(s=>z.t.reduce((v,b,m)=>v+(b?-1:1)*(pop(s&m)%2?-1:1),0));}
function anf(z){const a=z.t.slice();for(let k=0;k<z.n;k++)for(let m=0;m<a.length;m++)if(m>>k&1)a[m]^=a[m^(1<<k)];return a;}
export function booleanEvaluate(x){const[z,m]=w(x);return freeze({value:z.t[m]});}
export function booleanWeight(x){return freeze({ones:f(x).t.reduce((a,b)=>a+b,0)});}
export function booleanZeroCount(x){const z=f(x);return freeze({zeros:z.t.length-z.t.reduce((a,b)=>a+b,0)});}
export function booleanBalanced(x){const z=f(x);return freeze({balanced:z.t.reduce((a,b)=>a+b,0)*2===z.t.length});}
export function booleanSupport(x){const z=f(x);return freeze({variables:range(z.n).filter(k=>diff(z,k).some(Boolean))});}
export function booleanEssentialCount(x){const z=f(x);return freeze({count:range(z.n).filter(k=>diff(z,k).some(Boolean)).length});}
export function booleanCofactors(x){const[z,k]=c(x);return freeze({zero:co(z,k,0),one:co(z,k,1)});}
export function booleanRestrictZero(x){const[z,k]=c(x);return freeze({table:co(z,k,0)});}
export function booleanRestrictOne(x){const[z,k]=c(x);return freeze({table:co(z,k,1)});}
export function booleanDerivative(x){const[z,k]=c(x);return freeze({table:diff(z,k)});}
export function booleanDerivativeWeight(x){const[z,k]=c(x);return freeze({weight:diff(z,k).reduce((a,b)=>a+b,0)});}
export function booleanWalshSpectrum(x){return freeze({spectrum:walsh(f(x))});}
export function booleanWalshCoefficient(x){const[z,k]=w(x);return freeze({coefficient:walsh(z)[k]});}
export function booleanAnf(x){return freeze({coefficients:anf(f(x))});}
export function booleanAlgebraicDegree(x){const a=anf(f(x));return freeze({degree:a.reduce((d,b,m)=>b?Math.max(d,pop(m)):d,-1)});}
export function booleanMonotone(x){const z=f(x);for(let m=0;m<z.t.length;m++)for(let k=0;k<z.n;k++)if(!(m>>k&1)&&z.t[m]>z.t[m|1<<k])return freeze({monotone:false});return freeze({monotone:true});}
export function booleanAffine(x){const a=anf(f(x));return freeze({affine:a.every((b,m)=>!b||pop(m)<=1)});}
export function booleanSymmetric(x){const z=f(x);return freeze({symmetric:z.t.every((b,m)=>z.t.every((b2,m2)=>pop(m)===pop(m2)?b===b2:true))});}
export function booleanSelfDual(x){const z=f(x),full=z.t.length-1;return freeze({selfDual:z.t.every((b,m)=>b===1-z.t[full^m])});}
export function booleanSatisfyingAssignment(x){const i=f(x).t.indexOf(1);return freeze({mask:i===-1?null:i});}
export function booleanFalsifyingAssignment(x){const i=f(x).t.indexOf(0);return freeze({mask:i===-1?null:i});}
export function booleanEquivalent(x){object(x,['left','right','n']);const a=f({n:x.n,table:x.left}),b=f({n:x.n,table:x.right});return freeze({equivalent:a.t.every((v,i)=>v===b.t[i])});}
export function booleanHammingDistance(x){object(x,['left','right','n']);const a=f({n:x.n,table:x.left}),b=f({n:x.n,table:x.right});return freeze({distance:a.t.filter((v,i)=>v!==b.t[i]).length});}
export function booleanNonlinearity(x){const z=f(x);return freeze({nonlinearity:(1<<Math.max(0,z.n-1))-Math.max(...walsh(z).map(Math.abs))/2});}
export function booleanCorrelationImmunityOne(x){const z=f(x),ws=walsh(z);return freeze({orderOne:range(z.n).every(k=>ws[1<<k]===0)});}
const withV={...src,variable:1},withM={...src,mask:3};
const specs=[
 ['EVALUATE','Evaluate Boolean function on a packed assignment',booleanEvaluate,withM],
 ['WEIGHT','Number of satisfying assignments',booleanWeight,src],
 ['ZERO_COUNT','Number of falsifying assignments',booleanZeroCount,src],
 ['BALANCED','Boolean truth-table balance property',booleanBalanced,src],
 ['SUPPORT','Essential variable support set',booleanSupport,src],
 ['ESSENTIAL_COUNT','Number of essential input variables',booleanEssentialCount,src],
 ['COFACTORS','Shannon zero and one cofactors',booleanCofactors,withV],
 ['RESTRICT_ZERO','Restrict a Boolean input variable to zero',booleanRestrictZero,withV],
 ['RESTRICT_ONE','Restrict a Boolean input variable to one',booleanRestrictOne,withV],
 ['DERIVATIVE','Boolean XOR derivative along one input',booleanDerivative,withV],
 ['DERIVATIVE_WEIGHT','Weight of a Boolean directional derivative',booleanDerivativeWeight,withV],
 ['WALSH','Full exact Walsh-Hadamard spectrum',booleanWalshSpectrum,src],
 ['WALSH_COEFF','One Walsh correlation coefficient',booleanWalshCoefficient,withM],
 ['ANF','Algebraic normal form by subset Moebius transform',booleanAnf,src],
 ['ALGEBRAIC_DEGREE','Degree of unique algebraic normal form',booleanAlgebraicDegree,src],
 ['MONOTONE','Monotonicity in Boolean lattice order',booleanMonotone,src],
 ['AFFINE','Affine Boolean function recognition',booleanAffine,src],
 ['SYMMETRIC','Hamming-weight permutation symmetry recognition',booleanSymmetric,src],
 ['SELF_DUAL','Complement-input self-duality recognition',booleanSelfDual,src],
 ['SAT_WITNESS','Lexicographically first satisfying assignment',booleanSatisfyingAssignment,src],
 ['FALSIFY_WITNESS','Lexicographically first falsifying assignment',booleanFalsifyingAssignment,src],
 ['EQUIVALENT','Equality of two complete Boolean truth functions',booleanEquivalent,{n:3,left:src.table,right:src.table}],
 ['HAMMING','Truth-table Hamming distance',booleanHammingDistance,{n:3,left:src.table,right:[0,1,0,0,1,0,0,1]}],
 ['NONLINEARITY','Minimum Hamming distance to affine Boolean functions',booleanNonlinearity,src],
 ['CORRELATION_IMMUNITY_1','First-order correlation-immunity test by Walsh coefficients',booleanCorrelationImmunityOne,src],
];
export const BOOLEAN_FUNCTIONS_900=entries(specs,'CS.BOOLEAN_FUNCTIONS','COMPUTER_SCIENCE',851);
