import test from 'node:test';
import assert from 'node:assert/strict';
import {BATCH_200_ADDITIONS} from '../core/batch-200-additions.mjs';

const assertFiniteJson=(value,path)=>{
 if(typeof value==='number')assert(Number.isFinite(value),`${path} is not finite`);
 else if(Array.isArray(value))value.forEach((child,i)=>assertFiniteJson(child,`${path}[${i}]`));
 else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value))assertFiniteJson(child,`${path}.${key}`);
 else assert(value===null||typeof value==='string'||typeof value==='boolean',`${path} cannot be represented as JSON`);
};

test('all 84 distinct new implementations execute deterministic JSON-finite results and reject malformed required inputs',()=>{
 assert.equal(BATCH_200_ADDITIONS.length,84);
 assert.equal(new Set(BATCH_200_ADDITIONS.map(def=>def.id)).size,84);
 assert.equal(new Set(BATCH_200_ADDITIONS.map(def=>def.execute)).size,84);
 for(const definition of BATCH_200_ADDITIONS){
  assert.equal(typeof definition.execute,'function',definition.id);
  assert(Object.keys(definition.input).length>0,`${definition.id} needs a real problem input`);
  const first=definition.execute(structuredClone(definition.input));
  assert.deepEqual(first,definition.execute(structuredClone(definition.input)),`${definition.id} is nondeterministic`);
  assertFiniteJson(first,definition.id);
  assert.equal(typeof JSON.stringify(first),'string',`${definition.id} has no JSON representation`);
  assert.throws(()=>definition.execute(null),{name:'TypeError'},`${definition.id} accepted null`);
  const malformed=structuredClone(definition.input),firstField=Object.keys(malformed)[0];
  delete malformed[firstField];
  assert.throws(()=>definition.execute(malformed),`${definition.id} accepted missing ${firstField}`);
 }
});
