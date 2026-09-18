/* Independent integer polynomial reference: monomial sums, binomial expansion and direct evaluation. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['EXACT_POLY_ADD','EXACT_POLY_SUB','EXACT_POLY_MUL','EXACT_POLY_EVAL','EXACT_POLY_DERIV','EXACT_POLY_DERIV2','EXACT_POLY_DEGREE','EXACT_POLY_LEADING','EXACT_POLY_CONTENT','EXACT_POLY_PRIMITIVE','EXACT_POLY_REVERSE','EXACT_POLY_NEGATE_X','EXACT_POLY_EVEN','EXACT_POLY_ODD','EXACT_POLY_SCALE','EXACT_POLY_SCALE_X','EXACT_POLY_SHIFT_X','EXACT_POLY_TRUNC','EXACT_POLY_POWER','EXACT_POLY_COMPOSE','EXACT_POLY_HORNER_TRACE','EXACT_POLY_SYNTHETIC_DIV','EXACT_POLY_ROOT_TEST','EXACT_POLY_SUM_COEFF','EXACT_POLY_ALT_COEFF'];
const trim=a=>{a=a.slice();while(a.length>1&&a.at(-1)===0n)a.pop();return a;};
const poly=a=>({coefficients:trim(a).map(String)}),value=x=>({value:String(x)});
const abs=x=>x<0n?-x:x,gcd=(x,y)=>y===0n?abs(x):gcd(y,x%y);
const evaluate=(a,t)=>a.reduce((s,c,i)=>s+c*t**BigInt(i),0n);
const mul=(a,b)=>{const c=Array(a.length+b.length-1).fill(0n);for(const [i,x] of a.entries())for(const [j,y] of b.entries())c[i+j]+=x*y;return trim(c);};
const add=(a,b,sign=1n)=>trim(seq(Math.max(a.length,b.length)).map(i=>(a[i]??0n)+sign*(b[i]??0n)));
const derivative=a=>trim(a.length===1?[0n]:a.slice(1).map((v,i)=>v*BigInt(i+1)));
function input(tag,i,r){const n=1+i%6,make=()=>seq(n).map(()=>r(9)-4),a=make();if(i%11===0)a.fill(0);const x={coefficients:a};
 if(['EXACT_POLY_ADD','EXACT_POLY_SUB','EXACT_POLY_MUL','EXACT_POLY_COMPOSE'].includes(tag))return {left:a,right:make()};
 if(['EXACT_POLY_EVAL','EXACT_POLY_HORNER_TRACE'].includes(tag))return {...x,at:r(9)-4};
 if(['EXACT_POLY_SCALE','EXACT_POLY_SCALE_X'].includes(tag))return {...x,factor:r(7)-3};
 if(tag==='EXACT_POLY_SHIFT_X')return {...x,places:r(5)};
 if(tag==='EXACT_POLY_TRUNC')return {...x,degree:r(7)};
 if(tag==='EXACT_POLY_POWER')return {...x,exponent:r(5)};
 if(['EXACT_POLY_SYNTHETIC_DIV','EXACT_POLY_ROOT_TEST'].includes(tag))return {...x,root:r(9)-4};
 return x;
}
function ref(tag,x){const a=(x.coefficients??x.left).map(BigInt),b=x.right?.map(BigInt),n=a.length,t=BigInt(x.at??x.root??0);
 switch(tag){
 case 'EXACT_POLY_ADD':return poly(add(a,b));
 case 'EXACT_POLY_SUB':return poly(add(a,b,-1n));
 case 'EXACT_POLY_MUL':return poly(mul(a,b));
 case 'EXACT_POLY_EVAL':return value(evaluate(a,t));
 case 'EXACT_POLY_DERIV':return poly(derivative(a));
 case 'EXACT_POLY_DERIV2':return poly(derivative(derivative(a)));
 case 'EXACT_POLY_DEGREE':{const c=trim(a);return {degree:c.length===1&&c[0]===0n?null:c.length-1};}
 case 'EXACT_POLY_LEADING':return value(trim(a).at(-1));
 case 'EXACT_POLY_CONTENT':return value(a.reduce(gcd,0n));
 case 'EXACT_POLY_PRIMITIVE':{const g=a.reduce(gcd,0n);return poly(g?a.map(v=>v/g):[0n]);}
 case 'EXACT_POLY_REVERSE':return poly(trim(a).reverse());
 case 'EXACT_POLY_NEGATE_X':return poly(a.map((v,i)=>i%2?-v:v));
 case 'EXACT_POLY_EVEN':return poly(a.map((v,i)=>i%2?0n:v));
 case 'EXACT_POLY_ODD':return poly(a.map((v,i)=>i%2?v:0n));
 case 'EXACT_POLY_SCALE':return poly(a.map(v=>v*BigInt(x.factor)));
 case 'EXACT_POLY_SCALE_X':return poly(a.map((v,i)=>v*BigInt(x.factor)**BigInt(i)));
 case 'EXACT_POLY_SHIFT_X':return poly([...Array(x.places).fill(0n),...a]);
 case 'EXACT_POLY_TRUNC':return poly(a.slice(0,x.degree+1));
 case 'EXACT_POLY_POWER':{let c=[1n];for(let j=0;j<x.exponent;j++)c=mul(c,a);return poly(c);}
 case 'EXACT_POLY_COMPOSE':{const c=Array(Math.max(1,(n-1)*(b.length-1)+1)).fill(0n);for(let i=0;i<n;i++)for(let j=0;j<=i*(b.length-1);j++){let p=[1n];for(let k=0;k<i;k++)p=mul(p,b);c[j]+=a[i]*(p[j]??0n);}return poly(c);}
 case 'EXACT_POLY_HORNER_TRACE':{const accumulators=seq(n).map(k=>evaluate(a.slice(n-1-k),t));return {accumulators:accumulators.map(String),result:String(accumulators.at(-1))};}
 case 'EXACT_POLY_SYNTHETIC_DIV':{const c=trim(a);if(c.length===1)return {quotient:['0'],remainder:String(c[0])};const q=Array(c.length-1).fill(0n);for(let i=c.length-1;i>=1;i--){q[i-1]=c[i]+(q[i]??0n)*t;}return {quotient:trim(q).map(String),remainder:String(evaluate(c,t))};}
 case 'EXACT_POLY_ROOT_TEST':return {isRoot:evaluate(a,t)===0n};
 case 'EXACT_POLY_SUM_COEFF':return value(a.reduce((s,v)=>s+v,0n));
 case 'EXACT_POLY_ALT_COEFF':return value(a.reduce((s,v,i)=>s+(i%2?-v:v),0n));
 default:throw Error('missing polynomial reference '+tag);
 }
}
export const runIntegerPolynomial438Bank=options=>runBatchBank({name:'AXIOMA integer polynomial monomial references 301–325',prefix:'MATH',start:301,tags,input,reference:ref,...options});
