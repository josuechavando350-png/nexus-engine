import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GAUSS_IMPLEMENTED_LAYERS} from '../core/registry.mjs';
import {runAxioma} from '../axioma/run.mjs';

test('AXIOMA inventories exactly the remaining registered operators without duplicates',()=>{
 const report=runAxioma();
 const covered=new Set(report.suites.flatMap(suite=>suite.operatorResults.map(item=>item.id)));
 const missing=GAUSS_IMPLEMENTED_LAYERS.filter(layer=>!covered.has(layer.id));
 assert.equal(missing.length,52);
 assert.equal(new Set(missing.map(item=>item.id)).size,52);
 assert.equal(covered.size+missing.length,GAUSS_IMPLEMENTED_LAYERS.length);
 for(let i=0;i<missing.length;i+=20)console.log('AXIOMA_REMAINING_'+String(i/20).padStart(2,'0')+'='+JSON.stringify(missing.slice(i,i+20).map(({id,domain,description})=>({id,domain,description}))));
});
