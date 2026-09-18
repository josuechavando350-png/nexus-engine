// Exact rational polynomial and formal power-series operations (bounded degrees).
import {object,arr,int,freeze,entries,q,qa,qs,qm,qd,qneg,qstr,zero,one,choose,gcd} from './batch-1000-common.mjs';
const Z=zero(),O=one();
const trim=a=>{const b=a.slice();while(b.length>1&&b.at(-1).n===0n)b.pop();return b.length?b:[Z];};
const get=(a,i)=>a[i]??Z;
const fmt=a=>a.map(qstr);
function series(x){object(x,['coefficients']);return trim(arr(x.coefficients,'coefficients',1,12).map(q));}
function two(x){object(x,['left','right']);return [series({coefficients:x.left}),series({coefficients:x.right})];}
function plus(a,b){return trim(Array.from({length:Math.max(a.length,b.length)},(_,i)=>qa(get(a,i),get(b,i))));}
function minus(a,b){return trim(Array.from({length:Math.max(a.length,b.length)},(_,i)=>qs(get(a,i),get(b,i))));}
function times(a,b){let r=Array.from({length:a.length+b.length-1},()=>Z);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)r[i+j]=qa(r[i+j],qm(a[i],b[j]));return trim(r);}
function deriv(a){return trim(a.slice(1).map((v,i)=>qm(v,q(i+1))));}
function integ(a){return [Z,...a.map((v,i)=>qd(v,q(i+1)))];}
function val(a,t){let r=Z;for(let i=a.length-1;i>=0;i--)r=qa(qm(r,t),a[i]);return r;}
function trunc(a,n){return trim([...a.slice(0,n),...Array.from({length:Math.max(0,n-a.length)},()=>Z)]);}
function reciprocal(a,n){if(a[0].n===0n)throw new RangeError('series constant must be nonzero');const r=[qd(O,a[0])];for(let k=1;k<n;k++){let s=Z;for(let j=1;j<=k;j++)s=qa(s,qm(get(a,j),r[k-j]));r.push(qneg(qd(s,a[0])));}return r;}
function divrem(a,b){if(b.length===1&&b[0].n===0n)throw new RangeError('division by zero polynomial');let r=trim(a),d=Array.from({length:Math.max(1,a.length-b.length+1)},()=>Z);while(!(r.length===1&&r[0].n===0n)&&r.length>=b.length){let k=r.length-b.length,v=qd(r.at(-1),b.at(-1));d[k]=v;let t=[...Array.from({length:k},()=>Z),...b.map(x=>qm(x,v))];r=minus(r,t);}return {quotient:trim(d),remainder:r};}
function xrec(x){object(x,['coefficients','count']);return [series({coefficients:x.coefficients}),int(x.count,'count',1,12)];}
function scal(x){object(x,['coefficients','scalar']);return [series({coefficients:x.coefficients}),q(x.scalar)];}
function at(x){object(x,['coefficients','at']);return [series({coefficients:x.coefficients}),q(x.at)];}
export function rationalSeriesNormalize(x){return freeze({coefficients:fmt(series(x))});}
export function rationalSeriesDegree(x){return freeze({degree:series(x).length-1});}
export function rationalSeriesLeading(x){return freeze({leading:qstr(series(x).at(-1))});}
export function rationalSeriesEvaluate(x){const [a,t]=at(x);return freeze({value:qstr(val(a,t))});}
export function rationalSeriesDerivative(x){return freeze({coefficients:fmt(deriv(series(x)))});}
export function rationalSeriesIntegral(x){return freeze({coefficients:fmt(integ(series(x)))});}
export function rationalSeriesAdd(x){const[a,b]=two(x);return freeze({coefficients:fmt(plus(a,b))});}
export function rationalSeriesSubtract(x){const[a,b]=two(x);return freeze({coefficients:fmt(minus(a,b))});}
export function rationalSeriesProduct(x){const[a,b]=two(x);return freeze({coefficients:fmt(times(a,b))});}
export function rationalSeriesScale(x){const[a,s]=scal(x);return freeze({coefficients:fmt(trim(a.map(c=>qm(c,s))))});}
export function rationalSeriesShift(x){object(x,['coefficients','places']);const a=series({coefficients:x.coefficients}),k=int(x.places,'places',0,12);return freeze({coefficients:fmt(a.length===1&&a[0].n===0n?a:[...Array.from({length:k},()=>Z),...a])});}
export function rationalSeriesTruncate(x){const[a,n]=xrec(x);return freeze({coefficients:fmt(trunc(a,n))});}
export function rationalSeriesReverse(x){return freeze({coefficients:fmt(trim(series(x).slice().reverse()))});}
export function rationalSeriesCompose(x){const[a,b]=two(x);if(a.length*b.length>144)throw new RangeError('composition budget');let r=[Z];for(let i=a.length-1;i>=0;i--)r=plus(times(r,b),[a[i]]);return freeze({coefficients:fmt(r)});}
export function rationalSeriesReciprocal(x){const[a,n]=xrec(x);return freeze({coefficients:fmt(reciprocal(a,n))});}
export function rationalSeriesQuotient(x){object(x,['left','right','count']);const a=series({coefficients:x.left}),b=series({coefficients:x.right}),n=int(x.count,'count',1,12);return freeze({coefficients:fmt(trunc(times(a,reciprocal(b,n)),n))});}
export function rationalSeriesLogDerivative(x){const a=series(x);return freeze({coefficients:fmt(trunc(times(deriv(a),reciprocal(a,a.length)),a.length))});}
export function rationalSeriesFormalLog(x){const[a,n]=xrec(x);if(a[0].n!==1n||a[0].d!==1n)throw new RangeError('formal logarithm requires constant term 1');return freeze({coefficients:fmt(trunc(integ(trunc(times(deriv(a),reciprocal(a,n)),n-1)),n))});}
export function rationalSeriesFormalExp(x){const[a,n]=xrec(x);if(a[0].n!==0n)throw new RangeError('formal exponential requires constant term 0');let r=[O];for(let k=1;k<n;k++){let v=Z;for(let j=1;j<=k;j++)v=qa(v,qm(qm(q(j),get(a,j)),r[k-j]));r.push(qd(v,q(k)));}return freeze({coefficients:fmt(trim(r))});}
export function rationalSeriesPower(x){object(x,['coefficients','power','count']);const a=series({coefficients:x.coefficients}),p=int(x.power,'power',-8,8),n=int(x.count,'count',1,12);let r=[O],b=p<0?reciprocal(a,n):a,k=Math.abs(p);while(k){if(k%2)r=trunc(times(r,b),n);k=Math.floor(k/2);if(k)b=trunc(times(b,b),n);}return freeze({coefficients:fmt(trunc(r,n))});}
export function rationalSeriesHadamard(x){const[a,b]=two(x);return freeze({coefficients:fmt(trim(Array.from({length:Math.max(a.length,b.length)},(_,i)=>qm(get(a,i),get(b,i)))))});}
export function rationalSeriesEvenPart(x){const a=series(x);return freeze({coefficients:fmt(trim(a.map((v,i)=>i%2?Z:v)))});}
export function rationalSeriesOddPart(x){const a=series(x);return freeze({coefficients:fmt(trim(a.map((v,i)=>i%2?v:Z)))});}
export function rationalSeriesTranslate(x){object(x,['coefficients','shift']);const a=series({coefficients:x.coefficients}),s=q(x.shift),r=Array.from({length:a.length},()=>Z);for(let i=0;i<a.length;i++){let power=O;for(let j=i;j>=0;j--){r[j]=qa(r[j],qm(qm(a[i],q(choose(i,j).toString())),power));power=qm(power,s);}}return freeze({coefficients:fmt(trim(r))});}
export function rationalSeriesDivide(x){const[a,b]=two(x),r=divrem(a,b);return freeze({quotient:fmt(r.quotient),remainder:fmt(r.remainder)});}
const C=[1,'1/2','-3/4',2],B=[1,2,'1/3'];
const specs=[
 ['NORMALIZE','Canonical exact rational coefficient vector',rationalSeriesNormalize,{coefficients:C}],
 ['DEGREE','Exact polynomial degree',rationalSeriesDegree,{coefficients:C}],
 ['LEADING','Exact leading coefficient',rationalSeriesLeading,{coefficients:C}],
 ['EVALUATE','Exact Horner rational evaluation',rationalSeriesEvaluate,{coefficients:C,at:'2/3'}],
 ['DERIVATIVE','Exact analytic rational derivative',rationalSeriesDerivative,{coefficients:C}],
 ['INTEGRAL','Exact zero-constant rational antiderivative',rationalSeriesIntegral,{coefficients:C}],
 ['ADD','Exact rational polynomial sum',rationalSeriesAdd,{left:C,right:B}],
 ['SUBTRACT','Exact rational polynomial difference',rationalSeriesSubtract,{left:C,right:B}],
 ['PRODUCT','Exact rational coefficient convolution',rationalSeriesProduct,{left:C,right:B}],
 ['SCALE','Exact scalar multiplication of rational polynomial',rationalSeriesScale,{coefficients:C,scalar:'3/5'}],
 ['SHIFT','Exact multiplication by an integer power of x',rationalSeriesShift,{coefficients:C,places:2}],
 ['TRUNCATE','Exact degree-truncated formal power series',rationalSeriesTruncate,{coefficients:C,count:3}],
 ['REVERSE','Reversal of rational polynomial coefficients',rationalSeriesReverse,{coefficients:C}],
 ['COMPOSE','Exact rational polynomial composition',rationalSeriesCompose,{left:C,right:B}],
 ['RECIPROCAL','Formal rational series reciprocal to specified order',rationalSeriesReciprocal,{coefficients:[1,2,3],count:7}],
 ['QUOTIENT','Formal rational series division to specified order',rationalSeriesQuotient,{left:C,right:[1,2],count:7}],
 ['LOG_DERIVATIVE','Exact rational logarithmic derivative truncated to input degree',rationalSeriesLogDerivative,{coefficients:[1,2,1]}],
 ['FORMAL_LOG','Exact formal logarithm of unit series',rationalSeriesFormalLog,{coefficients:[1,2,1],count:7}],
 ['FORMAL_EXP','Exact formal exponential of zero-constant series',rationalSeriesFormalExp,{coefficients:[0,2,1],count:7}],
 ['INTEGER_POWER','Exact signed integer formal series power',rationalSeriesPower,{coefficients:[1,1,1],power:-3,count:7}],
 ['HADAMARD','Coefficientwise rational Hadamard product',rationalSeriesHadamard,{left:C,right:B}],
 ['EVEN_PART','Projection onto even powers of x',rationalSeriesEvenPart,{coefficients:C}],
 ['ODD_PART','Projection onto odd powers of x',rationalSeriesOddPart,{coefficients:C}],
 ['TRANSLATE','Exact rational polynomial argument translation',rationalSeriesTranslate,{coefficients:C,shift:'1/2'}],
 ['DIVIDE','Exact rational polynomial Euclidean quotient and remainder',rationalSeriesDivide,{left:[-1,0,1],right:[-1,1]}],
];
export const RATIONAL_SERIES_900=entries(specs,'MATH.RATIONAL_SERIES','MATHEMATICS',801);
