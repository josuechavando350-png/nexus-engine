import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GAUSS_IMPLEMENTED_LAYERS} from '../core/registry.mjs';
import {runAxioma} from '../axioma/run.mjs';

test('AXIOMA inventories all 1000 registered operators with no missing or duplicate references',()=>{
 const report=runAxioma();
 const ids=report.suites.flatMap(suite=>suite.operatorResults.map(item=>item.id));
 const covered=new Set(ids);
 const registry=new Set(GAUSS_IMPLEMENTED_LAYERS.map(layer=>layer.id));
 const missing=GAUSS_IMPLEMENTED_LAYERS.filter(layer=>!covered.has(layer.id));
 assert.equal(registry.size,1000,'registry must contain 1000 unique implementations');
 assert.equal(ids.length,covered.size,'duplicate references must not inflate coverage');
 assert.deepStrictEqual(covered,registry,'independently checked IDs must match the entire GAUSS registry');
 assert.deepStrictEqual(missing,[],'no registered GAUSS operator may remain unverified');
 assert.equal(report.coveredOperators,1000);
 assert.equal(report.untestedOperators,0);
 console.log('AXIOMA_REMAINING_00='+JSON.stringify(missing));
});
