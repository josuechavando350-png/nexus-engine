import assert from 'node:assert/strict';
import test from 'node:test';
import {exactIntegerPolynomialDiscriminant as discriminant} from '../core/layers/integer-polynomial-discriminant.mjs';
const disc=f=>BigInt(discriminant({coefficients:f}).discriminant);
function independent(f){
 if(f.length===2)return 1n;
 if(f.length===3){const [c,b,a]=f;return b*b-4n*a*c;}
 const [d,c,b,a]=f;
 return b*b*c*c-4n*a*c*c*c-4n*b*b*b*d-27n*a*a*d*d+18n*a*b*c*d;
}
test('quadratic/cubic discriminants match 240 independently evaluated closed formulas',()=>{
 let state=0xa5349012;
 const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return BigInt(state%101)-50n;};
 for(let i=0;i<240;i++){
  const degree=2+i%2;
  const f=Array.from({length:degree+1},random);
  if(f[degree]===0n)f[degree]=1n;
  assert.equal(disc(f.map(String)),independent(f),`discriminant case ${i}`);
 }
});
test('linear convention, repeated roots, quartic and canonical 38-digit inputs',()=>{
 assert.equal(disc([3,4]),1n);
 assert.equal(disc([1,-2,1]),0n);
 assert.equal(discriminant({coefficients:[1,-2,1]}).repeatedComplexRoot,true);
 assert.equal(disc([1,0,0,0,1]),256n);
 const m='9'.repeat(38);
 assert.equal(disc([m,0,1]),-4n*BigInt(m));
});
test('rejects malformed, imprecise and overbudget inputs',()=>{
 for(const input of [[],[1],[1,0],[1,1.3],[1,Number.MAX_SAFE_INTEGER+1],[1,'01'],[1,'-0'],[1,'1'.repeat(39)],Array(8).fill(1)]){
  assert.throws(()=>discriminant({coefficients:input}));
 }
});
