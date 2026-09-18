import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runPartitionBank} from '../axioma/partitions-compositions-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA independently enumerates 25 partition and composition operators',()=>{const r=runPartitionBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runPartitionBank());});
test('AXIOMA catches fabricated partition counts and malformed input acceptance',()=>{const r=runPartitionBank({resolveLayer:id=>id==='GAUSS.MATH.PARTITIONS_COMPOSITIONS.PART_DISTINCT.827'?{execute:()=>({value:'-1'})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
