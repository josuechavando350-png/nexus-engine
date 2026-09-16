// Bounded real polynomial computations, ascending-power coefficient convention.
const fail=m=>{throw new TypeError(m);};
const shape=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join('|')!==keys.slice().sort().join('|'))fail(`expected exactly ${keys.join(',')}`);};
const num=(v,label,bound=1e4)=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>bound)fail(`${label} must be finite and bounded`);return v;};
const arr=(v,label,min=1,max=13)=>{if(!Array.isArray(v)||v.length<min||v.length>max)fail(`${label} size invalid`);return v.map((x,i)=>num(x,`${label}[${i}]`));};
const finite=v=>{if(!Number.isFinite(v)||Math.abs(v)>1e15)fail('polynomial numerical result exceeds bounded precision range');return v;};
const freeze=Object.freeze;
const trimmed=v=>{while(v.length>1&&v.at(-1)===0)v.pop();return v.map(finite);};
const evalPoly=(p,x)=>{let s=0;for(let i=p.length-1;i>=0;i--)s=finite(s*x+p[i]);return s;};
const multiply=(a,b)=>{const out=Array(a.length+b.length-1).fill(0);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)out[i+j]=finite(out[i+j]+a[i]*b[j]);return trimmed(out);};
export function hornerPolynomialEvaluation(input){shape(input,['coefficients','at']);const p=arr(input.coefficients,'coefficients'),x=num(input.at,'at',10);return freeze({value:evalPoly(p,x)});}
export function analyticPolynomialDerivative(input){shape(input,['coefficients']);const p=arr(input.coefficients,'coefficients');return freeze({coefficients:freeze(p.length===1?[0]:trimmed(p.slice(1).map((v,i)=>finite(v*(i+1)))))});}
export function definitePolynomialIntegral(input){shape(input,['coefficients','lower','upper']);const p=arr(input.coefficients,'coefficients'),a=num(input.lower,'lower',10),b=num(input.upper,'upper',10);
 const primitive=p.map((v,i)=>v/(i+1));return freeze({integral:finite(b*evalPoly(primitive,b)-a*evalPoly(primitive,a))});}
export function polynomialConvolutionProduct(input){shape(input,['left','right']);const a=arr(input.left,'left'),b=arr(input.right,'right');return freeze({coefficients:freeze(multiply(a,b))});}
export function realPolynomialLongDivision(input){shape(input,['dividend','divisor']);const a=trimmed(arr(input.dividend,'dividend')),b=trimmed(arr(input.divisor,'divisor'));
 if(b.at(-1)===0)fail('zero divisor polynomial');if(a.length<b.length)return freeze({quotient:freeze([0]),remainder:freeze(a)});
 const q=Array(a.length-b.length+1).fill(0),r=a.slice();for(let k=q.length-1;k>=0;k--){q[k]=finite(r[k+b.length-1]/b.at(-1));for(let j=0;j<b.length;j++)r[k+j]=finite(r[k+j]-q[k]*b[j]);}
 const remainder=r.slice(0,b.length-1);return freeze({quotient:freeze(trimmed(q)),remainder:freeze(remainder.length?trimmed(remainder):[0])});}
export function barycentricLagrangeInterpolation(input){shape(input,['nodes','values','at']);const x=arr(input.nodes,'nodes',1,12),y=arr(input.values,'values',1,12),at=num(input.at,'at',10);if(x.length!==y.length||new Set(x).size!==x.length)fail('distinct nodes and matching values required');
 for(let i=0;i<x.length;i++)if(at===x[i])return freeze({value:y[i]});let numerator=0,denominator=0;
 for(let i=0;i<x.length;i++){let w=1;for(let j=0;j<x.length;j++)if(i!==j)w/=x[i]-x[j];const v=w/(at-x[i]);numerator+=v*y[i];denominator+=v;}
 if(!denominator)fail('unstable interpolation denominator');return freeze({value:finite(numerator/denominator)});}
export function newtonDividedDifferenceTable(input){shape(input,['nodes','values']);const x=arr(input.nodes,'nodes',1,12),a=arr(input.values,'values',1,12);if(x.length!==a.length||new Set(x).size!==x.length)fail('distinct nodes and matching values required');
 const out=[a[0]];for(let order=1;order<x.length;order++){for(let i=0;i<x.length-order;i++)a[i]=finite((a[i+1]-a[i])/(x[i+order]-x[i]));out.push(a[0]);}
 return freeze({nodes:freeze(x),newtonCoefficients:freeze(out)});}
// An IEEE-754 float is an exact dyadic rational. Compare b² and 4ac with
// BigInt mantissas: ordinary Number multiplication may underflow both to 0,
// causing a genuine pair of roots to be misclassified as a double root.
const quadraticBits = new DataView(new ArrayBuffer(8));
const exactDyadic = value => {
 quadraticBits.setFloat64(0, value, false);
 const hi=quadraticBits.getUint32(0,false),lo=quadraticBits.getUint32(4,false);
 const exponent=(hi>>>20)&2047;
 const fraction=(BigInt(hi&0xfffff)<<32n)|BigInt(lo);
 const mantissa=(hi>>>31?-1n:1n)*(exponent?fraction+(1n<<52n):fraction);
 return {mantissa, exponent:exponent?exponent-1075:-1074};
};
const binaryMagnitude = value => {
 const abs=value<0n?-value:value,bits=abs.toString(2).length;
 const shift=Math.max(0,bits-53);
 return {top:Number(abs>>BigInt(shift))/2**(bits-1-shift), exponent:bits-1};
};
function scaledQuadraticDiscriminant(a,b,c){
 const A=exactDyadic(a),B=exactDyadic(b),C=exactDyadic(c);
 const bExponent=2*B.exponent,acExponent=A.exponent+C.exponent;
 const common=Math.min(bExponent,acExponent);
 const numerator=(B.mantissa*B.mantissa<<BigInt(bExponent-common))-
  (4n*A.mantissa*C.mantissa<<BigInt(acExponent-common));
 if(numerator===0n)return {sign:0,normalized:0};
 const sign=numerator<0n?-1:1,scale=Math.max(Math.abs(a),Math.abs(b),Math.abs(c));
 const S=exactDyadic(scale),D=binaryMagnitude(numerator),M=binaryMagnitude(S.mantissa);
 const normalized=sign*(D.top/(M.top*M.top))*2**(common+D.exponent-2*(S.exponent+M.exponent));
 if(!Number.isFinite(normalized)||normalized===0||Math.sign(normalized)!==sign)
  fail('quadratic discriminant outside supported numerical precision');
 return {sign,normalized,scale};
}
// Verify returned binary64 roots against the *exact input floats*. A rounded
// subnormal c or b*root can otherwise create a convincing but false root.
function verifyQuadraticRoot(a,b,c,root){
 const A=exactDyadic(a),B=exactDyadic(b),C=exactDyadic(c),R=exactDyadic(root);
 const terms=[
  {m:A.mantissa*R.mantissa*R.mantissa,e:A.exponent+2*R.exponent},
  {m:B.mantissa*R.mantissa,e:B.exponent+R.exponent},
  {m:C.mantissa,e:C.exponent}
 ].filter(term=>term.m!==0n);
 if(!terms.length)return;
 const common=Math.min(...terms.map(term=>term.e));
 const values=terms.map(({m,e})=>m<<BigInt(e-common));
 const abs=value=>value<0n?-value:value;
 const magnitude=values.reduce((largest,value)=>largest>abs(value)?largest:abs(value),0n);
 const residual=abs(values.reduce((sum,value)=>sum+value,0n));
 if(residual*100000000n>magnitude)fail('quadratic root outside supported residual precision');
}
export function realQuadraticRootClassification(input){
 shape(input,['a','b','c']);const a=num(input.a,'a'),b=num(input.b,'b'),c=num(input.c,'c');
 if(a===0)fail('quadratic leading coefficient cannot vanish');
 const raw=b*b-4*a*c,{sign,normalized,scale}=scaledQuadraticDiscriminant(a,b,c);
 // Preserve the legacy field for representable cases; never claim a false
 // discriminant of zero if its true value underflows Number precision.
 const metadata=sign===0?{discriminant:0}:
  raw!==0&&Math.sign(raw)===sign?{discriminant:finite(raw)}:
  {discriminant:null,normalizedDiscriminant:normalized,coefficientScale:scale};
 if(sign<0)return freeze({...metadata,roots:freeze([]),realRootCount:0});
 const s=scale??Math.max(Math.abs(a),Math.abs(b),Math.abs(c));
 const A=a/s,B=b/s,C=c/s;
 if(A===0)fail('quadratic leading coefficient is numerically unresolvable');
 if(sign===0){
  const repeated=finite(-B/(2*A));
  if(repeated===0&&b!==0)fail('nonzero repeated quadratic root is numerically unresolvable');
  verifyQuadraticRoot(a,b,c,repeated);
  return freeze({...metadata,roots:freeze([repeated]),realRootCount:1});
 }
 const sqrt=Math.sqrt(normalized),q=-0.5*(B+Math.sign(B||1)*sqrt);
 if(q===0)fail('quadratic roots are numerically unresolvable');
 // Preserve a tiny nonzero c that may disappear in c / scale.
 const smallRoot=C===0&&c!==0?c/(s*q):C/q;
 const roots=[q/A,smallRoot].map(value=>finite(value===0?0:value)).sort((u,v)=>u-v);
 // If c is nonzero, neither mathematical root is zero. A rounded zero
 // would be a fabricated exact root, even if the residual underflows.
 if(c!==0&&roots.some(root=>root===0))fail('nonzero quadratic root is numerically unresolvable');
 if(roots[0]===roots[1])fail('distinct quadratic roots cannot be resolved at Number precision');
 roots.forEach(root=>verifyQuadraticRoot(a,b,c,root));
 return freeze({...metadata,roots:freeze(roots),realRootCount:2});
}
export function polynomialComposition(input){shape(input,['outer','inner']);const outer=arr(input.outer,'outer',1,10),inner=arr(input.inner,'inner',1,10);if((outer.length-1)*(inner.length-1)>20)fail('composition exceeds degree bound');
 let result=[0];for(let i=outer.length-1;i>=0;i--){result=multiply(result,inner);result[0]=finite(result[0]+outer[i]);}return freeze({coefficients:freeze(trimmed(result))});}
export function polynomialArgumentTranslation(input){shape(input,['coefficients','shift']);const p=arr(input.coefficients,'coefficients'),a=num(input.shift,'shift',10),out=Array(p.length).fill(0);
 for(let k=0;k<p.length;k++){let choose=1;for(let j=0;j<=k;j++){out[j]=finite(out[j]+p[k]*choose*a**(k-j));choose=choose*(k-j)/(j+1);}}
 return freeze({coefficients:freeze(trimmed(out))});}
export function powerToBernsteinCoefficients(input){shape(input,['coefficients']);const p=arr(input.coefficients,'coefficients',1,13),n=p.length-1;
 const binom=(a,b)=>{let t=1;for(let j=1;j<=b;j++)t=t*(a-j+1)/j;return t;};
 const out=p.map((_,k)=>{let sum=0;for(let j=0;j<=k;j++)sum+=p[j]*binom(k,j)/binom(n,j);return finite(sum);});
 return freeze({bernsteinCoefficients:freeze(out)});}
export function forwardFiniteDifferenceTable(input){shape(input,['values']);const x=arr(input.values,'values',1,64),leading=[],rows=[];let row=x.slice();
 while(row.length){leading.push(row[0]);rows.push(freeze(row));row=row.slice(1).map((v,i)=>finite(v-row[i]));}
 return freeze({leadingDifferences:freeze(leading),rows:freeze(rows)});}
