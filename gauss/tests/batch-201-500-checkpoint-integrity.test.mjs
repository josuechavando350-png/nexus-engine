import test from 'node:test';
import assert from 'node:assert/strict';
import {GAUSS_IMPLEMENTED_LAYERS,gaussRegistrySummary,getGaussLayer} from '../core/registry.mjs';
import {BATCH_201_500_MATH_A} from '../core/batch-201-500-math-a.mjs';
import {BATCH_201_500_STATS_A} from '../core/batch-201-500-stats-a.mjs';
import {BATCH_201_500_PROBABILITY_B} from '../core/batch-201-500-probability-b.mjs';

const added=[...BATCH_201_500_MATH_A,...BATCH_201_500_STATS_A,...BATCH_201_500_PROBABILITY_B];
const finiteJson=value=>!JSON.stringify(value).match(/(?:NaN|Infinity)/);

test('201-500 checkpoint contributes exactly 108 distinct executable operators without weakening 001-200',()=>{
 assert.equal(added.length,108);
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,308);
 assert.equal(gaussRegistrySummary().implementedLayerCount,308);
 assert.equal(new Set(added.map(x=>x.id)).size,108);
 assert.equal(new Set(added.map(x=>x.execute)).size,108);
 assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.id)).size,308);
 assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size,308);
 for(const layer of added){
  assert.equal(getGaussLayer(layer.id),layer);
  assert.equal(typeof layer.description,'string');
  assert.ok(layer.description.trim().length>0);
  assert.equal(typeof layer.execute,'function');
  assert.ok(layer.input&&typeof layer.input==='object');
 }
});

test('every checkpoint fixture executes deterministically to finite JSON',()=>{
 for(const layer of added){
  const a=layer.execute(structuredClone(layer.input));
  const b=layer.execute(structuredClone(layer.input));
  assert.deepEqual(a,b,layer.id);
  assert.doesNotThrow(()=>JSON.stringify(a),layer.id);
  assert.ok(finiteJson(a),layer.id);
 }
});

test('checkpoint contracts reject representative malformed inputs',()=>{
 const cases=[
  ['GAUSS.MATH.L2_NORM.063',{samples:[]}],
  ['GAUSS.MATH.HARMONIC_MEAN.065',{samples:[1,0]}],
  ['GAUSS.MATH.COSINE_SIMILARITY.081',{left:[0,0],right:[1,1]}],
  ['GAUSS.STATS.UNBIASED_VARIANCE.028',{samples:[1]}],
  ['GAUSS.STATS.PERCENTILE.038',{samples:[1,2],probability:2}],
  ['GAUSS.STATS.MAPE.052',{left:[0,1],right:[1,1]}],
 ];
 for(const [id,input] of cases)assert.throws(()=>getGaussLayer(id).execute(input),undefined,id);
});
