import {record,integer,output,entries,range,choose,rational} from './batch-800-common.mjs';
function U(x){record(x,['red','blue','draws']);const r=integer(x.red,'red',0,20),b=integer(x.blue,'blue',0,20),d=integer(x.draws,'draws',0,r+b);if(r+b===0)throw new RangeError('urn cannot be empty');return {r,b,d,n:r+b};}
const K=x=>{record(x,['red','blue','draws','k']);const u=U({red:x.red,blue:x.blue,draws:x.draws});return {...u,k:integer(x.k,'k',0,40)};};
const Q=x=>{record(x,['red','blue','draws','numerator','denominator']);const u=U({red:x.red,blue:x.blue,draws:x.draws}),num=integer(x.numerator,'numerator',0,1000000),den=integer(x.denominator,'denominator',1,1000000);if(num>den)throw new RangeError('quantile must be in [0,1]');return {...u,num:BigInt(num),den:BigInt(den)};};
const h=u=>{const den=choose(u.n,u.d),mass=range(u.d+1).map(k=>choose(u.r,k)*choose(u.b,u.d-k));return {mass,den};};
const bi=u=>{const den=BigInt(u.n)**BigInt(u.d),mass=range(u.d+1).map(k=>choose(u.d,k)*BigInt(u.r)**BigInt(k)*BigInt(u.b)**BigInt(u.d-k));return {mass,den};};
const dist=x=>output({probabilities:x.mass.map(v=>rational(v,x.den))});
const pm=(x,k)=>output({probability:rational(x.mass[k]??0n,x.den)});
const cdf=(x,k)=>output({probability:rational(x.mass.slice(0,k+1).reduce((s,v)=>s+v,0n),x.den)});
const tail=(x,k)=>output({probability:rational(x.mass.slice(k).reduce((s,v)=>s+v,0n),x.den)});
const mean=(x)=>output({mean:rational(x.mass.reduce((s,v,k)=>s+BigInt(k)*v,0n),x.den)});
const variance=x=>{const m=x.mass.reduce((s,v,k)=>s+BigInt(k)*v,0n),second=x.mass.reduce((s,v,k)=>s+BigInt(k*k)*v,0n);return output({variance:rational(second*x.den-m*m,x.den*x.den)});};
const mode=x=>{let max=0n;for(const v of x.mass)if(v>max)max=v;return output({values:range(x.mass.length).filter(i=>x.mass[i]===max)});};
const quantile=(x,num,den)=>{let sum=0n;for(let i=0;i<x.mass.length;i++){sum+=x.mass[i];if(sum*den>=num*x.den)return output({value:i});}throw new Error('invalid normalized distribution');};
const entropy=x=>{let e=0;for(const v of x.mass)if(v){const p=Number(v)/Number(x.den);e-=p*Math.log2(p);}return output({bits:e});};
const even=x=>output({probability:rational(x.mass.reduce((s,v,k)=>s+(k%2===0?v:0n),0n),x.den)});
const H=x=>h(U(x)),B=x=>bi(U(x));
export function urnWithoutReplacementDistribution(x){return dist(H(x));}
export function urnWithoutReplacementPmf(x){const u=K(x);return pm(h(u),u.k);}
export function urnWithoutReplacementCdf(x){const u=K(x);return cdf(h(u),u.k);}
export function urnWithoutReplacementTail(x){const u=K(x);return tail(h(u),u.k);}
export function urnWithoutReplacementMean(x){return mean(H(x));}
export function urnWithoutReplacementVariance(x){return variance(H(x));}
export function urnWithoutReplacementModes(x){return mode(H(x));}
export function urnWithoutReplacementQuantile(x){const u=Q(x);return quantile(h(u),u.num,u.den);}
export function urnWithoutReplacementEntropy(x){return entropy(H(x));}
export function urnWithoutReplacementEven(x){return even(H(x));}
export function urnWithoutReplacementZero(x){const p=H(x);return pm(p,0);}
export function urnWithoutReplacementAll(x){const u=U(x);return pm(h(u),u.d);}
export function urnWithoutReplacementAtLeastOne(x){const p=H(x);return tail(p,1);}
export function urnWithoutReplacementMajority(x){const u=U(x);return tail(h(u),Math.floor(u.d/2)+1);}
export function urnWithReplacementDistribution(x){return dist(B(x));}
export function urnWithReplacementPmf(x){const u=K(x);return pm(bi(u),u.k);}
export function urnWithReplacementCdf(x){const u=K(x);return cdf(bi(u),u.k);}
export function urnWithReplacementTail(x){const u=K(x);return tail(bi(u),u.k);}
export function urnWithReplacementMean(x){return mean(B(x));}
export function urnWithReplacementVariance(x){return variance(B(x));}
export function urnWithReplacementModes(x){return mode(B(x));}
export function urnWithReplacementQuantile(x){const u=Q(x);return quantile(bi(u),u.num,u.den);}
export function urnWithReplacementEntropy(x){return entropy(B(x));}
export function urnWithReplacementEven(x){return even(B(x));}
export function urnWithReplacementAll(x){const u=U(x);return pm(bi(u),u.d);}
const s={red:6,blue:4,draws:4},k={...s,k:2},q={...s,numerator:1,denominator:2};
const specs=[['URN_HYPERGEOMETRIC_DISTRIBUTION','Exact multivariate-count hypergeometric red-count distribution',urnWithoutReplacementDistribution,s],['URN_HYPERGEOMETRIC_PMF','Exact hypergeometric count probability',urnWithoutReplacementPmf,k],['URN_HYPERGEOMETRIC_CDF','Exact hypergeometric lower cumulative probability',urnWithoutReplacementCdf,k],['URN_HYPERGEOMETRIC_TAIL','Exact hypergeometric upper tail probability',urnWithoutReplacementTail,k],['URN_HYPERGEOMETRIC_MEAN','Exact expected red draws without replacement',urnWithoutReplacementMean,s],['URN_HYPERGEOMETRIC_VARIANCE','Exact finite-population red-count variance',urnWithoutReplacementVariance,s],['URN_HYPERGEOMETRIC_MODES','All maximizing hypergeometric count values',urnWithoutReplacementModes,s],['URN_HYPERGEOMETRIC_QUANTILE','Exact discrete inverse CDF of hypergeometric draws',urnWithoutReplacementQuantile,q],['URN_HYPERGEOMETRIC_ENTROPY','Shannon entropy of hypergeometric red-count distribution',urnWithoutReplacementEntropy,s],['URN_HYPERGEOMETRIC_EVEN','Exact probability of an even red count without replacement',urnWithoutReplacementEven,s],['URN_HYPERGEOMETRIC_ZERO','Exact probability of no red draws without replacement',urnWithoutReplacementZero,s],['URN_HYPERGEOMETRIC_ALL','Exact probability every draw is red without replacement',urnWithoutReplacementAll,s],['URN_HYPERGEOMETRIC_ANY','Exact probability at least one red without replacement',urnWithoutReplacementAtLeastOne,s],['URN_HYPERGEOMETRIC_MAJORITY','Exact probability red exceeds half of draws without replacement',urnWithoutReplacementMajority,s],['URN_BINOMIAL_DISTRIBUTION','Exact red-count distribution for draws with replacement',urnWithReplacementDistribution,s],['URN_BINOMIAL_PMF','Exact binomial red-count probability with replacement',urnWithReplacementPmf,k],['URN_BINOMIAL_CDF','Exact binomial lower cumulative probability',urnWithReplacementCdf,k],['URN_BINOMIAL_TAIL','Exact binomial upper tail probability',urnWithReplacementTail,k],['URN_BINOMIAL_MEAN','Exact red-count mean with replacement',urnWithReplacementMean,s],['URN_BINOMIAL_VARIANCE','Exact red-count variance with replacement',urnWithReplacementVariance,s],['URN_BINOMIAL_MODES','All maximizing binomial red-count outcomes',urnWithReplacementModes,s],['URN_BINOMIAL_QUANTILE','Exact inverse CDF for binomial red-count draws',urnWithReplacementQuantile,q],['URN_BINOMIAL_ENTROPY','Shannon entropy of binomial count distribution',urnWithReplacementEntropy,s],['URN_BINOMIAL_EVEN','Exact probability of an even red count with replacement',urnWithReplacementEven,s],['URN_BINOMIAL_ALL','Exact probability every draw is red with replacement',urnWithReplacementAll,s]];
export const URN_PROBABILITY_800=entries(specs,'STATS','STATISTICS_PROBABILITY',776);
