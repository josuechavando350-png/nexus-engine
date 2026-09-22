import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicVeluChain} from '../isogeny-81-chain.mjs';
import {verifyClaimedPublicVeluChain} from '../isogeny-81-claim.mjs';
import {runGaussNemesis} from '../bridge.mjs';

const statement={p:11,a:1,b:0,points:[null,{x:0,y:0},{x:5,y:3}],steps:[{degree:2,generator:{x:0,y:0}}]};
// Find a fully enumerated point on curve rather than relying on a fixture coincidence.
const actualPoints=[];
for(let x=0;x<11;x++)for(let y=0;y<11;y++)if((y*y-x*x*x-x)%11===0)actualPoints.push({x,y});
statement.points=[null,{x:0,y:0},actualPoints.find(P=>P.y!==0)];
const original=evaluatePublicVeluChain(statement);
const claim={statement,expected:{target:original.target,degreeProduct:original.degreeProduct,images:original.images}};
const clone=x=>structuredClone(x);

test('81 public claim independently replays actual chain and reports limited domain',()=>{
  const result=verifyClaimedPublicVeluChain(claim);
  assert.equal(result.verified,true);
  assert.equal(result.pointsChecked,3);
  assert.match(result.domain,/NOT_SIGNATURE/);
  assert.match(result.warning,/NOT an authenticated signature/);
});
test('81 public claim refuses forged target, image, degree, generator and extra fields',()=>{
  const target=clone(claim);target.expected.target.a=(target.expected.target.a+1)%11;
  assert.throws(()=>verifyClaimedPublicVeluChain(target),/MISMATCH/);
  const image=clone(claim);image.expected.images[2]={x:0,y:0};
  assert.throws(()=>verifyClaimedPublicVeluChain(image),/MISMATCH/);
  const degree=clone(claim);degree.expected.degreeProduct='1';
  assert.throws(()=>verifyClaimedPublicVeluChain(degree),/MISMATCH/);
  const generator=clone(claim);generator.statement.steps[0].generator={x:1,y:1};
  assert.throws(()=>verifyClaimedPublicVeluChain(generator),/not on source/);
  const extra=clone(claim);extra.expected.images[2]={...extra.expected.images[2],extra:1};
  assert.throws(()=>verifyClaimedPublicVeluChain(extra),/expected.images\[2\]/);
  const nonCanonical=clone(claim);nonCanonical.expected.degreeProduct='02';
  assert.throws(()=>verifyClaimedPublicVeluChain(nonCanonical),/canonical/);
  const forged=clone(claim);forged.expected.signature='claimed';
  assert.throws(()=>verifyClaimedPublicVeluChain(forged),/expected: expected exactly/);
});
test('81 public claim is routed through GAUSS with no signature capability claim',async()=>{
  const result=await runGaussNemesis(81,{action:'verify-public-claim',payload:claim});
  assert.equal(result.verified,true);
  assert.match(result.domain,/NOT_SIGNATURE/);
  await assert.rejects(runGaussNemesis(81,{action:'sign',payload:claim}),/expected \{p,a,b,kernelX,points\}/);
});
test('81 public verifier replays two successive isogenies, rejecting a changed intermediate step',()=>{
  const twoSteps={...statement,steps:[{degree:2,generator:{x:0,y:0}},{degree:2,generator:{x:0,y:0}}]};
  const result=evaluatePublicVeluChain(twoSteps);
  const receipt={statement:twoSteps,expected:{target:result.target,degreeProduct:result.degreeProduct,images:result.images}};
  assert.equal(result.degreeProduct,'4');
  assert.equal(verifyClaimedPublicVeluChain(receipt).verified,true);
  const malicious=clone(receipt);
  malicious.statement.steps[1].generator={x:1,y:0};
  assert.throws(()=>verifyClaimedPublicVeluChain(malicious),/not on source|declared degree|smaller than/);
});
