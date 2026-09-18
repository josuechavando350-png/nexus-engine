import {fields,int,vector,scalar,pack,gcd,boundedBig} from './batch-400-common.mjs';
const poly=(v)=>vector(v,{min:1,max:24});
const norm=v=>{let a=v.slice();while(a.length>1&&a.at(-1)===0n)a.pop();return a;};
const P=x=>pack({coefficients:norm(x)});
const V=x=>pack({value:x});
const unary=x=>poly(fields(x,['coefficients']).coefficients);
const binary=x=>{fields(x,['left','right']);return [poly(x.left),poly(x.right)];};
const mul=(a,b)=>{const out=Array(a.length+b.length-1).fill(0n);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)out[i+j]=boundedBig(out[i+j]+a[i]*b[j]);return norm(out);};
const deriv=a=>norm(a.length===1?[0n]:a.slice(1).map((c,i)=>c*BigInt(i+1)));
const evalAt=(a,x)=>a.reduceRight((s,c)=>boundedBig(s*x+c),0n);
const content=a=>a.reduce((s,c)=>gcd(s,c),0n);
export function polyExactAdd(input){const [a,b]=binary(input);return P(Array.from({length:Math.max(a.length,b.length)},(_,i)=>(a[i]??0n)+(b[i]??0n)));}
export function polyExactSubtract(input){const [a,b]=binary(input);return P(Array.from({length:Math.max(a.length,b.length)},(_,i)=>(a[i]??0n)-(b[i]??0n)));}
export function polyExactProduct(input){const [a,b]=binary(input);return P(mul(a,b));}
export function polyExactEvaluation(input){fields(input,['coefficients','at']);return V(evalAt(poly(input.coefficients),scalar(input.at)));}
export function polyExactDerivative(input){return P(deriv(unary(input)));}
export function polyExactSecondDerivative(input){return P(deriv(deriv(unary(input))));}
export function polyExactDegree(input){const a=norm(unary(input));return pack({degree:a.length===1&&a[0]===0n?null:a.length-1});}
export function polyExactLeading(input){return V(norm(unary(input)).at(-1));}
export function polyExactContent(input){return V(content(unary(input)));}
export function polyExactPrimitivePart(input){const a=unary(input),g=content(a);return P(g?a.map(x=>x/g):[0n]);}
export function polyExactReverse(input){return P(norm(unary(input)).reverse());}
export function polyExactNegateArgument(input){return P(unary(input).map((c,i)=>i%2?-c:c));}
export function polyExactEvenPart(input){return P(unary(input).map((c,i)=>i%2?0n:c));}
export function polyExactOddPart(input){return P(unary(input).map((c,i)=>i%2?c:0n));}
export function polyExactScale(input){fields(input,['coefficients','factor']);return P(poly(input.coefficients).map(c=>c*scalar(input.factor)));}
export function polyExactArgumentScale(input){fields(input,['coefficients','factor']);let pow=1n,f=scalar(input.factor);return P(poly(input.coefficients).map(c=>{const v=c*pow;pow=boundedBig(pow*f);return v;}));}
export function polyExactShiftPowers(input){fields(input,['coefficients','places']);const a=poly(input.coefficients),n=int(input.places,'places',0,24);if(a.length+n>48)throw new RangeError('degree budget');return P([...Array(n).fill(0n),...a]);}
export function polyExactTruncate(input){fields(input,['coefficients','degree']);const a=poly(input.coefficients),d=int(input.degree,'degree',0,23);return P(a.slice(0,d+1));}
export function polyExactPower(input){fields(input,['coefficients','exponent']);const a=poly(input.coefficients),e=int(input.exponent,'exponent',0,8);if((a.length-1)*e>48)throw new RangeError('degree budget');let r=[1n],x=a,p=e;while(p){if(p&1)r=mul(r,x);p>>=1;if(p)x=mul(x,x);}return P(r);}
export function polyExactComposition(input){const [a,b]=binary(input);if((a.length-1)*(b.length-1)>48)throw new RangeError('degree budget');let r=[0n];for(let i=a.length-1;i>=0;i--){r=mul(r,b);r[0]+=a[i];}return P(r);}
export function polyExactHornerTrace(input){fields(input,['coefficients','at']);const a=poly(input.coefficients),x=scalar(input.at),trace=[];let acc=0n;for(let i=a.length-1;i>=0;i--){acc=boundedBig(acc*x+a[i]);trace.push(acc);}return pack({accumulators:trace,result:acc});}
export function polyExactSyntheticDivision(input){fields(input,['coefficients','root']);const a=norm(poly(input.coefficients)),r=scalar(input.root);if(a.length===1)return pack({quotient:[0n],remainder:a[0]});let b=Array(a.length-1).fill(0n);b[b.length-1]=a.at(-1);for(let i=b.length-2;i>=0;i--)b[i]=a[i+1]+r*b[i+1];return pack({quotient:norm(b),remainder:a[0]+r*b[0]});}
export function polyExactIntegerRootTest(input){fields(input,['coefficients','root']);return pack({isRoot:evalAt(poly(input.coefficients),scalar(input.root))===0n});}
export function polyExactCoefficientSum(input){return V(unary(input).reduce((s,c)=>s+c,0n));}
export function polyExactAlternatingSum(input){return V(unary(input).reduce((s,c,i)=>s+(i%2?-c:c),0n));}
const sample={coefficients:[1,-2,3,1]};
const definitions=[
 ['EXACT_POLY_ADD','Exact coefficientwise addition',polyExactAdd,{left:[1,2],right:[3,-4,5]}],
 ['EXACT_POLY_SUB','Exact coefficientwise subtraction',polyExactSubtract,{left:[1,2],right:[3,4,5]}],
 ['EXACT_POLY_MUL','Exact convolution product',polyExactProduct,{left:[1,2],right:[-3,4]}],
 ['EXACT_POLY_EVAL','Exact Horner evaluation',polyExactEvaluation,{...sample,at:3}],
 ['EXACT_POLY_DERIV','Exact integer derivative',polyExactDerivative,sample],
 ['EXACT_POLY_DERIV2','Exact second integer derivative',polyExactSecondDerivative,sample],
 ['EXACT_POLY_DEGREE','Degree after removal of leading zero coefficients',polyExactDegree,sample],
 ['EXACT_POLY_LEADING','Leading coefficient of canonical polynomial',polyExactLeading,sample],
 ['EXACT_POLY_CONTENT','Nonnegative gcd of all polynomial coefficients',polyExactContent,sample],
 ['EXACT_POLY_PRIMITIVE','Canonical primitive integer polynomial',polyExactPrimitivePart,sample],
 ['EXACT_POLY_REVERSE','Reciprocal coefficient reversal',polyExactReverse,sample],
 ['EXACT_POLY_NEGATE_X','Substitute negative argument',polyExactNegateArgument,sample],
 ['EXACT_POLY_EVEN','Projection onto even powers',polyExactEvenPart,sample],
 ['EXACT_POLY_ODD','Projection onto odd powers',polyExactOddPart,sample],
 ['EXACT_POLY_SCALE','Multiply by integer scalar',polyExactScale,{...sample,factor:-2}],
 ['EXACT_POLY_SCALE_X','Scale polynomial argument by integer',polyExactArgumentScale,{...sample,factor:2}],
 ['EXACT_POLY_SHIFT_X','Multiply by monomial x^k',polyExactShiftPowers,{...sample,places:3}],
 ['EXACT_POLY_TRUNC','Truncate at bounded degree',polyExactTruncate,{...sample,degree:2}],
 ['EXACT_POLY_POWER','Exact polynomial exponentiation by squaring',polyExactPower,{coefficients:[1,1],exponent:5}],
 ['EXACT_POLY_COMPOSE','Exact polynomial composition',polyExactComposition,{left:[1,2,1],right:[0,1,1]}],
 ['EXACT_POLY_HORNER_TRACE','Exact Horner accumulator sequence',polyExactHornerTrace,{...sample,at:2}],
 ['EXACT_POLY_SYNTHETIC_DIV','Monic linear polynomial synthetic division',polyExactSyntheticDivision,{coefficients:[-1,0,1],root:1}],
 ['EXACT_POLY_ROOT_TEST','Exact integer polynomial root predicate',polyExactIntegerRootTest,{coefficients:[-1,0,1],root:1}],
 ['EXACT_POLY_SUM_COEFF','Sum of integer coefficients',polyExactCoefficientSum,sample],
 ['EXACT_POLY_ALT_COEFF','Alternating sum of integer coefficients',polyExactAlternatingSum,sample],
];
export const EXACT_POLYNOMIAL_400=Object.freeze(definitions.map(([code,description,execute,input],i)=>Object.freeze({id:`GAUSS.MATH.${code}.${301+i}`,domain:'MATHEMATICS',description,execute,input:Object.freeze(input)})));
