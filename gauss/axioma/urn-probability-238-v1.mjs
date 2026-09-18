/* Oracle enumerates red/blue DRAW PATHS and counts labeled-ball multiplicities; no GAUSS combinatorial distribution is imported. */
import {runBatchBank,seq,frac,verifyExactOrNear} from './batch-238-common.mjs';
const tags=['URN_HYPERGEOMETRIC_DISTRIBUTION','URN_HYPERGEOMETRIC_PMF','URN_HYPERGEOMETRIC_CDF','URN_HYPERGEOMETRIC_TAIL','URN_HYPERGEOMETRIC_MEAN','URN_HYPERGEOMETRIC_VARIANCE','URN_HYPERGEOMETRIC_MODES','URN_HYPERGEOMETRIC_QUANTILE','URN_HYPERGEOMETRIC_ENTROPY','URN_HYPERGEOMETRIC_EVEN','URN_HYPERGEOMETRIC_ZERO','URN_HYPERGEOMETRIC_ALL','URN_HYPERGEOMETRIC_ANY','URN_HYPERGEOMETRIC_MAJORITY','URN_BINOMIAL_DISTRIBUTION','URN_BINOMIAL_PMF','URN_BINOMIAL_CDF','URN_BINOMIAL_TAIL','URN_BINOMIAL_MEAN','URN_BINOMIAL_VARIANCE','URN_BINOMIAL_MODES','URN_BINOMIAL_QUANTILE','URN_BINOMIAL_ENTROPY','URN_BINOMIAL_EVEN','URN_BINOMIAL_ALL'];
function input(tag,i,r){let red=i%9===0?0:i%9===1?1:1+r(6),blue=i%9===2?0:i%9===3?1:1+r(6);if(red+blue===0)blue=1;const draws=i%13===0?0:i%13===1?red+blue:r(Math.min(5,red+blue)+1),base={red,blue,draws};
 if(tag.endsWith('_PMF')||tag.endsWith('_CDF')||tag.endsWith('_TAIL'))return {...base,k:i%6===0?0:i%6===1?draws:i%6===2?draws+1:r(8)};
 if(tag.endsWith('_QUANTILE'))return {...base,numerator:i%7===0?0:i%7===1?1:i%7===2?3:r(101),denominator:100};
 return base;}
function paths(red,blue,draws,replace){const counts=Array(draws+1).fill(0n);function visit(r,b,steps,redDraws,multiplicity){if(steps===draws){counts[redDraws]+=multiplicity;return;}if(r>0)visit(replace?r:r-1,replace?b:b,steps+1,redDraws+1,multiplicity*BigInt(r));if(b>0)visit(replace?r:r,replace?b:b-1,steps+1,redDraws,multiplicity*BigInt(b));}visit(red,blue,0,0,1n);return counts;}
function reference(tag,x){const replace=tag.startsWith('URN_BINOMIAL'),mass=paths(x.red,x.blue,x.draws,replace),sum=mass.reduce((a,b)=>a+b,0n),n=mass.length;
 const probability=arr=>frac(arr.reduce((a,b)=>a+b,0n),sum);
 const pmf=k=>({probability:frac(mass[k]??0n,sum)});
 const cumulative=k=>({probability:probability(mass.filter((_,j)=>j<=k))});
 const upper=k=>({probability:probability(mass.filter((_,j)=>j>=k))});
 const mean=mass.reduce((s,v,i)=>s+BigInt(i)*v,0n),second=mass.reduce((s,v,i)=>s+BigInt(i*i)*v,0n),mx=mass.reduce((a,b)=>a>b?a:b,0n);
 if(tag.endsWith('_DISTRIBUTION'))return {probabilities:mass.map(m=>frac(m,sum))};
 if(tag.endsWith('_PMF'))return pmf(x.k);
 if(tag.endsWith('_CDF'))return cumulative(x.k);
 if(tag.endsWith('_TAIL'))return upper(x.k);
 if(tag.endsWith('_MEAN'))return {mean:frac(mean,sum)};
 if(tag.endsWith('_VARIANCE'))return {variance:frac(second*sum-mean*mean,sum*sum)};
 if(tag.endsWith('_MODES'))return {values:seq(n).filter(k=>mass[k]===mx)};
 if(tag.endsWith('_QUANTILE')){let cumulativeMass=0n;for(const k of seq(n)){cumulativeMass+=mass[k];if(cumulativeMass*BigInt(x.denominator)>=BigInt(x.numerator)*sum)return {value:k};}throw Error('quantile normalization failed');}
 if(tag.endsWith('_ENTROPY')){let bits=0;for(const m of mass){if(m){const p=Number(m)/Number(sum);bits-=p*Math.log2(p);}}return {bits};}
 if(tag.endsWith('_EVEN'))return {probability:probability(mass.filter((_,k)=>k%2===0))};
 if(tag.endsWith('_ZERO'))return pmf(0);
 if(tag.endsWith('_ALL'))return pmf(x.draws);
 if(tag.endsWith('_ANY'))return upper(1);
 if(tag.endsWith('_MAJORITY'))return upper(Math.floor(x.draws/2)+1);
 throw Error(`unimplemented independent urn reference: ${tag}`);
}
function verify(tag,input,actual,expected){if(tag.endsWith('_ENTROPY'))verifyExactOrNear(actual,expected);else{importAssert(actual,expected);}}
import {deepStrictEqual as importAssert} from 'node:assert/strict';
export const runUrn238Bank=options=>runBatchBank({name:'AXIOMA urns 776-800',prefix:'STATS',start:776,tags,input,reference,verify,...options});
