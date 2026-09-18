#!/usr/bin/env node
// Deterministic local latency sample only; not a comparative speed claim.
import {performance} from 'node:perf_hooks';
import {BATCH_400_ADDITIONS} from '../core/batch-400-additions.mjs';
function percentile(sorted,p){return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];}
const groups=[];
for(const [domain,ops] of Object.entries(Object.groupBy(BATCH_400_ADDITIONS,x=>x.domain))){
 const samples=[];for(let i=0;i<5;i++)for(const op of ops)op.execute(op.input);
 for(let i=0;i<40;i++){const start=performance.now();for(const op of ops)op.execute(op.input);samples.push(performance.now()-start);}
 samples.sort((a,b)=>a-b);groups.push({domain,operators:ops.length,samples:40,p50BatchMs:samples[19],p95BatchMs:percentile(samples,.95)});
}
console.log(JSON.stringify({node:process.version,arch:process.arch,platform:process.platform,rssBytes:process.memoryUsage().rss,method:'40 batches per domain, 5 warmups; sample fixtures only; no comparison or performance guarantee',groups},null,2));
