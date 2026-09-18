/* BigInt floor-division continued fractions, analytic Wilson intervals and independent seeded bootstrap. */
import assert from 'node:assert/strict';
import {runFinalBank,range} from './final-common-v1.mjs';
const close=(a,b)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=2e-8*Math.max(1,Math.abs(b)),`${a} vs ${b}`);
const compare=(actual,expected)=>{assert.deepStrictEqual(Object.keys(actual).sort(),Object.keys(expected).sort());for(const [k,v] of Object.entries(expected)){if(typeof v==='number'&&k!=='seed'&&k!=='resamples')close(actual[k],v);else assert.deepStrictEqual(actual[k],v);}};
const floorDiv=(a,b)=>{let q=a/b;if(a<0n&&a%b!==0n)q--;return q;};
const fraction=x=>{let a=BigInt(x.numerator),b=BigInt(x.denominator),q=[];while(b!==0n){const v=floorDiv(a,b);q.push(Number(v));[a,b]=[b,a-v*b];}return {quotients:q};};
const quantile=(a,p)=>{const j=(a.length-1)*p,lo=Math.floor(j),hi=Math.ceil(j);return a[lo]+(a[hi]-a[lo])*(j-lo);};
const bootstrap=x=>{let state=x.seed>>>0;const draw=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>=0)/4294967296;};const means=[];for(let j=0;j<x.resamples;j++){let sum=0;for(const _ of x.samples)sum+=x.samples[Math.floor(draw()*x.samples.length)];means.push(sum/x.samples.length);}means.sort((a,b)=>a-b);const alpha=(1-x.confidence)/2;return {mean:x.samples.reduce((a,b)=>a+b,0)/x.samples.length,lower:quantile(means,alpha),upper:quantile(means,1-alpha),confidence:x.confidence,resamples:x.resamples,seed:x.seed};};
const defs=[
{id:'GAUSS.MATH.RATIONAL_CONTINUED_FRACTION.056',make:(i,r)=>({numerator:r(2000001)-1000000,denominator:1+r(999999)}),reference:fraction,invalid:x=>[null,{...x,denominator:0},{...x,unexpected:true}]},
{id:'GAUSS.STATS.WILSON.001',make:(i,r)=>{const trials=1+r(10000);return {successes:r(trials+1),trials,confidence:0.95};},reference:x=>{const z=1.959963984540054,z2=z*z,p=x.successes/x.trials,den=1+z2/x.trials,center=(p+z2/(2*x.trials))/den,margin=z/den*Math.sqrt((p*(1-p)+z2/(4*x.trials))/x.trials);return {estimate:p,lower:Math.max(0,center-margin),upper:Math.min(1,center+margin),confidence:x.confidence};},invalid:x=>[null,{...x,successes:x.trials+1},{...x,confidence:1}],verify:compare},
{id:'GAUSS.STATS.BOOTSTRAP_MEAN.003',make:(i,r)=>({samples:range(2+r(6)).map(()=>r(31)-15),confidence:0.9,resamples:100+r(10),seed:1+r(0x7ffffffe)}),reference:bootstrap,invalid:x=>[null,{...x,samples:[3]},{...x,seed:0}],verify:compare}
];
export const runFinalRationalStatisticsBank=options=>runFinalBank({name:'AXIOMA exact rational continued fractions, analytic Wilson and independently seeded bootstrap percentile references',definitions:defs,...options});
