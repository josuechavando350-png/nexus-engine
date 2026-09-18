import {writeFile} from 'node:fs/promises';
import {BATCH_500_ADDITIONS} from '../core/batch-500-additions.mjs';
const fixture={schemaVersion:1,batch:'401–500',objective:'Offline deterministic execution of exactly 100 new native computational kernels; no integration or certification of Nexus is implied.',tasks:BATCH_500_ADDITIONS.map(({id,input})=>({taskId:id,layerId:id,input}))};
await writeFile(new URL('../fixtures/batch-500-problem.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n');
console.log(`Fixture generated: ${fixture.tasks.length} tasks`);
