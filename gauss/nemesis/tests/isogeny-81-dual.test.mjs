import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTwoIsogeny} from '../engine/src/motors/isogeny-2.mjs';
import {verifyTwoIsogenyDualIdentity} from '../isogeny-81-foundation.mjs';

const mod=(n,p)=>((n%p)+p)%p;
const primes=[5,7,11,13,17,19,23,29,31,37,41,43];
function points(p,a,b){
  const result=[null];
  for(let x=0;x<p;x++)for(let y=0;y<p;y++)
    if(mod(y*y-x*x*x-a*x-b,p)===0)result.push({x,y});
  return result;
}
// Full small-field exhaustive independent oracle, not just fixed examples.
test('81: exact dual composition equals [2] on every rational point of nonsingular curves',()=>{
  let curves=0,pointsChecked=0;
  for(const p of primes)for(let a=0;a<p;a++)for(let r=0;r<p;r++){
    const b=mod(-r*r*r-a*r,p);
    if(mod(4*a*a*a+27*b*b,p)===0)continue;
    const all=points(p,a,b);
    const result=verifyTwoIsogenyDualIdentity({p,a,b,kernelX:r,points:all});
    assert.equal(result.pointsChecked,all.length);
    assert.equal(result.verified,true);
    assert.match(result.domain,/NOT_SIGNATURE/);
    curves++;pointsChecked+=all.length;
  }
  assert.ok(curves>1000);assert.ok(pointsChecked>10000);
});
test('81: the dual identity rejects malformed points, curves and kernels',()=>{
  const base={p:11,a:1,b:0,kernelX:0,points:[null,{x:0,y:0},{x:5,y:2}]};
  assert.throws(()=>verifyTwoIsogenyDualIdentity(base),/not on source/);
  assert.throws(()=>verifyTwoIsogenyDualIdentity({...base,points:[null],kernelX:1}),/2-torsion/);
  assert.throws(()=>verifyTwoIsogenyDualIdentity({...base,points:[null],p:9}),/odd prime/);
  assert.throws(()=>verifyTwoIsogenyDualIdentity({...base,points:[null],a:0}),/singular/);
});
test('81: independent Vélu and dual map annihilate the two-element kernel',()=>{
  const input={p:11,a:1,b:0,kernelX:0,points:[null,{x:0,y:0}]};
  const original=evaluateTwoIsogeny(input);
  assert.deepEqual(original.images,[null,null]);
  const dual=verifyTwoIsogenyDualIdentity(input);
  assert.deepEqual(dual.doubled,[null,null]);
  assert.deepEqual(dual.dualKernel,{x:0,y:0});
});
