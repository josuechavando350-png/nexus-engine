import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {BATCH_500_ADDITIONS} from '../core/batch-500-additions.mjs';
const groups=new Map();for(const op of BATCH_500_ADDITIONS){if(!groups.has(op.domain))groups.set(op.domain,[]);groups.get(op.domain).push(op);}
const result={scope:'fixture-only, in-process Node.js, no competing implementation, no general performance claim',node:process.version,groups:{}};
for(const [domain,ops] of groups){for(let i=0;i<3;i++)for(const op of ops)op.execute(op.input);
 const t=performance.now();for(let j=0;j<40;j++)for(const op of ops)op.execute(op.input);
 result.groups[domain]={operations:ops.length,executions:ops.length*40,totalMilliseconds:Number((performance.now()-t).toFixed(3))};}
await writeFile(new URL('../../benchmark.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
