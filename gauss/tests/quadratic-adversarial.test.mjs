import test from 'node:test';
import assert from 'node:assert/strict';
import {realQuadraticRootClassification as classify} from '../core/layers/polynomial-algebra.mjs';
const rng=(()=>{let x=0x9e3779b9;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/2**32;};})();
const rand=(lo,hi)=>Math.floor(rng()*(hi-lo+1))+lo;
const close=(x,y,tol=1e-8)=>assert(Math.abs(x-y)<=tol*Math.max(1,Math.abs(x),Math.abs(y)),`${x} vs ${y}`);
test('exact sign and residuals on 12,000 scaled integer quadratics',()=>{
 let success=0,expectedRejections=0;
 const scales=[1,1e-30,1e-100,1e-160,1e-200,1e-250,1e-300,Number.MIN_VALUE];
 for(let t=0;t<12000;t++){
  const u=rand(-10,10)||1,v=rand(-10,10),w=rand(-10,10),s=scales[rand(0,scales.length-1)];
  const a=u*s,b=v*s,c=w*s;
  if(a===0)continue;
  try{
   const actual=classify({a,b,c});
   const exactD=v*v-4*u*w;
   if(exactD>0){assert.equal(actual.realRootCount,2);const expected=[(-v-Math.sqrt(exactD))/(2*u),(-v+Math.sqrt(exactD))/(2*u)].sort((x,y)=>x-y);actual.roots.forEach((r,i)=>close(r,expected[i],1e-6));}
   else if(exactD<0)assert.equal(actual.realRootCount,0);
   else {
    if(actual.realRootCount===1)close(actual.roots[0],-v/(2*u),1e-6);
    else if(actual.realRootCount===2)actual.roots.forEach(r=>close(r,-v/(2*u),1e-6));
    else assert.equal(actual.realRootCount,0);
   }
   for(const r of actual.roots){const scaledA=a/s,scaledB=b/s,scaledC=c/s;
    const residual=scaledA*r*r+scaledB*r+scaledC;
    assert(Math.abs(residual)<1e-6*Math.max(1,Math.abs(scaledA*r*r),Math.abs(scaledB*r),Math.abs(scaledC)),`residual ${residual}`);
   }
   success++;
  }catch(e){
   if(e instanceof TypeError && /numerical|precision|bounded/.test(e.message)){expectedRejections++;continue;}
   throw new Error(`case ${JSON.stringify({a,b,c,u,v,w,s})}: ${e.stack}`,{cause:e});
  }
 }
 assert(success>11500,`too many numerical rejections ${success}/${expectedRejections}`);
 console.log(`adversarial sample: ${success} successes; ${expectedRejections} explicit fail-closed rejections`);
});

test('subnormal nonzero constant never becomes a fabricated exact zero root',()=>{
 for(const a of [1,10000])for(const b of [10000,-10000])for(const c of [Number.MIN_VALUE,-Number.MIN_VALUE]){
  assert.throws(()=>classify({a,b,c}),/numerically unresolvable/);
 }
});

test('rounded subnormal root residuals fail closed against exact float inputs',()=>{
 for(const input of [
  {a:2,b:-7.888609052210118e-31,c:1.5e-323},
  {a:1,b:-1e-160,c:-Number.MIN_VALUE},
  {a:-3,b:7.888609052210118e-30,c:-1e-323},
  {a:-3,b:7.888609052210118e-31,c:1e-323}
 ])assert.throws(()=>classify(input),/residual precision/);
});
