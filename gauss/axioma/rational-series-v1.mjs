/* AXIOMA rational-series references use standalone normalized BigInt fractions; no GAUSS arithmetic is imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['NORMALIZE','DEGREE','LEADING','EVALUATE','DERIVATIVE','INTEGRAL','ADD','SUBTRACT','PRODUCT','SCALE','SHIFT','TRUNCATE','REVERSE','COMPOSE','RECIPROCAL','QUOTIENT','LOG_DERIVATIVE','FORMAL_LOG','FORMAL_EXP','INTEGER_POWER','HADAMARD','EVEN_PART','ODD_PART','TRANSLATE','DIVIDE'];
const id=(tag,i)=>`GAUSS.MATH.RATIONAL_SERIES.${tag}.${801+i}`;
function gcd(a,b){a=a<0n?-a:a;b=b<0n?-b:b;while(b!==0n){const r=a%b;a=b;b=r;}return a;}
function fraction(n,d=1n){if(d===0n)throw Error('zero denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};}
function q(value){if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('invalid integer fraction');return fraction(BigInt(value));}const [a,b='1']=value.split('/');return fraction(BigInt(a),BigInt(b));}
const Z=()=>fraction(0n),O=()=>fraction(1n);
const plus=(a,b)=>fraction(a.n*b.d+b.n*a.d,a.d*b.d);
const minus=(a,b)=>fraction(a.n*b.d-b.n*a.d,a.d*b.d);
const times=(a,b)=>fraction(a.n*b.n,a.d*b.d);
const divide=(a,b)=>fraction(a.n*b.d,a.d*b.n);
const str=a=>`${a.n}/${a.d}`;
const trimmed=a=>{const result=a.slice();while(result.length>1&&result.at(-1).n===0n)result.pop();return result.length?result:[Z()];};
const parse=values=>trimmed(values.map(q));
const at=(v,i)=>v[i]??Z();
const format=a=>a.map(str);
function convolution(a,b){const out=Array.from({length:a.length+b.length-1},Z);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)out[i+j]=plus(out[i+j],times(a[i],b[j]));return trimmed(out);}
function sum(a,b){return trimmed(Array.from({length:Math.max(a.length,b.length)},(_,i)=>plus(at(a,i),at(b,i))));}
function difference(a,b){return trimmed(Array.from({length:Math.max(a.length,b.length)},(_,i)=>minus(at(a,i),at(b,i))));}
const derivative=a=>trimmed(a.slice(1).map((v,i)=>times(v,q(i+1))));
const integral=a=>[Z(),...a.map((v,i)=>divide(v,q(i+1)))];
const truncate=(a,n)=>trimmed(Array.from({length:n},(_,i)=>at(a,i)));
function reciprocal(a,n){if(a[0].n===0n)throw Error('non-invertible formal series');const out=[divide(O(),a[0])];for(let k=1;k<n;k++){let value=Z();for(let j=1;j<=k;j++)value=plus(value,times(at(a,j),out[k-j]));out.push(divide(fraction(-value.n,value.d),a[0]));}return out;}
function power(a,exponent,n){let out=[O()],base=exponent<0?reciprocal(a,n):a;for(let i=0;i<Math.abs(exponent);i++)out=truncate(convolution(out,base),n);return truncate(out,n);}
function choose(n,k){let out=1n;for(let i=1;i<=k;i++)out=out*BigInt(n-i+1)/BigInt(i);return out;}
function longDivide(a,b){if(b.length===1&&b[0].n===0n)throw Error('zero polynomial divisor');const quotient=Array.from({length:Math.max(1,a.length-b.length+1)},Z);let remainder=trimmed(a);
 while(remainder.length>=b.length&&!(remainder.length===1&&remainder[0].n===0n)){
 const shift=remainder.length-b.length,mult=divide(remainder.at(-1),b.at(-1));quotient[shift]=mult;
 const shifted=[...Array.from({length:shift},Z),...b.map(v=>times(v,mult))];remainder=difference(remainder,shifted);
 }return {quotient:trimmed(quotient),remainder};}
function reference(tag,input){const a=parse(input.coefficients??input.left),b=input.right?parse(input.right):null;
 switch(tag){
 case 'NORMALIZE':return {coefficients:format(a)};
 case 'DEGREE':return {degree:a.length-1};
 case 'LEADING':return {leading:str(a.at(-1))};
 case 'EVALUATE':{const x=q(input.at);let result=Z(),power=O();for(const c of a){result=plus(result,times(c,power));power=times(power,x);}return {value:str(result)};}
 case 'DERIVATIVE':return {coefficients:format(derivative(a))};
 case 'INTEGRAL':return {coefficients:format(integral(a))};
 case 'ADD':return {coefficients:format(sum(a,b))};
 case 'SUBTRACT':return {coefficients:format(difference(a,b))};
 case 'PRODUCT':return {coefficients:format(convolution(a,b))};
 case 'SCALE':return {coefficients:format(trimmed(a.map(v=>times(v,q(input.scalar)))))};
 case 'SHIFT':return {coefficients:format(a.length===1&&a[0].n===0n?a:[...Array.from({length:input.places},Z),...a])};
 case 'TRUNCATE':return {coefficients:format(truncate(a,input.count))};
 case 'REVERSE':return {coefficients:format(trimmed(a.slice().reverse()))};
 case 'COMPOSE':{let out=[Z()],xp=[O()];for(const c of a){out=sum(out,xp.map(v=>times(v,c)));xp=convolution(xp,b);}return {coefficients:format(out)};}
 case 'RECIPROCAL':return {coefficients:format(reciprocal(a,input.count))};
 case 'QUOTIENT':return {coefficients:format(truncate(convolution(a,reciprocal(b,input.count)),input.count))};
 case 'LOG_DERIVATIVE':return {coefficients:format(truncate(convolution(derivative(a),reciprocal(a,a.length)),a.length))};
 case 'FORMAL_LOG':{const n=input.count,d=derivative(a),inv=reciprocal(a,n);return {coefficients:format(truncate(integral(truncate(convolution(d,inv),Math.max(1,n-1))),n))};}
 case 'FORMAL_EXP':{const n=input.count,out=[O()];for(let k=1;k<n;k++){let val=Z();for(let j=1;j<=k;j++)val=plus(val,times(times(q(j),at(a,j)),out[k-j]));out.push(divide(val,q(k)));}return {coefficients:format(trimmed(out))};}
 case 'INTEGER_POWER':return {coefficients:format(power(a,input.power,input.count))};
 case 'HADAMARD':return {coefficients:format(trimmed(Array.from({length:Math.max(a.length,b.length)},(_,i)=>times(at(a,i),at(b,i))))};
 case 'EVEN_PART':return {coefficients:format(trimmed(a.map((v,i)=>i%2?Z():v)))};
 case 'ODD_PART':return {coefficients:format(trimmed(a.map((v,i)=>i%2?v:Z())))};
 case 'TRANSLATE':{const shift=q(input.shift),out=Array.from({length:a.length},Z);for(let i=0;i<a.length;i++)for(let j=0;j<=i;j++){let s=O();for(let k=0;k<i-j;k++)s=times(s,shift);out[j]=plus(out[j],times(a[i],times(q(choose(i,j).toString()),s)));}return {coefficients:format(trimmed(out))};}
 case 'DIVIDE':{const result=longDivide(a,b);return {quotient:format(result.quotient),remainder:format(result.remainder)};}
 default:throw Error('unknown rational series oracle '+tag);
 }}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const coefficient=()=>{const value=r(7)-3;return r(5)===0?`${value}/2`:value;};let a=Array.from({length:1+r(4)},coefficient),b=Array.from({length:1+r(3)},coefficient);
 if(i%13===0)a=[0,0,0];if(i%17===0)b=[0];
 if(['RECIPROCAL','LOG_DERIVATIVE','INTEGER_POWER'].includes(tag))a[0]=a[0]===0?1:a[0];
 if(['QUOTIENT','DIVIDE'].includes(tag))b[b.length-1]=b[b.length-1]===0?1:b[b.length-1];
 if(tag==='QUOTIENT')b[0]=b[0]===0?1:b[0];
 if(tag==='FORMAL_LOG')a[0]=1;
 if(tag==='FORMAL_EXP')a[0]=0;
 if(tag==='NORMALIZE'||tag==='DEGREE'||tag==='LEADING'||tag==='DERIVATIVE'||tag==='INTEGRAL'||tag==='REVERSE'||tag==='LOG_DERIVATIVE'||tag==='EVEN_PART'||tag==='ODD_PART')return {coefficients:a};
 if(tag==='EVALUATE')return {coefficients:a,at:coefficient()};
 if(tag==='SCALE')return {coefficients:a,scalar:coefficient()};
 if(tag==='SHIFT')return {coefficients:a,places:r(5)};
 if(['TRUNCATE','RECIPROCAL','FORMAL_LOG','FORMAL_EXP'].includes(tag))return {coefficients:a,count:1+r(5)};
 if(tag==='INTEGER_POWER')return {coefficients:a,power:r(9)-4,count:1+r(5)};
 if(tag==='TRANSLATE')return {coefficients:a,shift:coefficient()};
 if(tag==='QUOTIENT')return {left:a,right:b,count:1+r(5)};
 return {left:a,right:b};
}
export function runRationalSeriesBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS exact rational formal series',seed:'0x3711abba',oracle:'standalone reduced BigInt fractions, monomial convolution, rational identities and independent finite recurrence',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');for(const [index,tag]of TAGS.entries()){
 const layerId=id(tag,index),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x3711abba),item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let j=0;j<100;j++){const input=inputFor(tag,j,r),expected=reference(tag,input);hash.update(JSON.stringify({id:layerId,j,input,expected}));item.validCases++;report.validCases++;let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,j,input,expected,actual:actual??null,reason:String(error)});}
 if(j===0){const field='coefficients'in input?'coefficients':'left',bad=[{...input,extra:true},{...input,[field]:[1.25]},{...input,[field]:['1/0']}];
 for(const[k,v]of bad.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(v));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,j:`invalid-${k}`,input:v,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }report.coveredOperators++;report.operatorResults.push(item);
 }report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
