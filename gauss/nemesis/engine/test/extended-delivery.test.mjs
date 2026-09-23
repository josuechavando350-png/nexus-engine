import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runMotorPipeline} from '../src/index.mjs';
test('trained CRF is consumed by a second motor and compared through pipeline references',async()=>{
 const spec=JSON.parse(readFileSync(new URL('../examples/v11/pipeline-trained-crf.json',import.meta.url))),r=await runMotorPipeline(spec);
 assert.equal(r.status,'PASS');assert.equal(r.tasks.length,3);assert.ok(r.tasks[2].output.kl<1e-10);
});
test('CLI rejects unconverged MDP and accepts QAOA fit with a measured small gap',()=>{
 const good=spawnSync(process.execPath,['cli.mjs','motor','examples/v11/motor-04-train.json','04'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(good.status,0,good.stderr);assert.ok(JSON.parse(good.stdout).expectationOptimalityGap<1e-6);
 const qp=spawnSync(process.execPath,['cli.mjs','motor','examples/motor-84-nonconverged.json','84'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(qp.status,1);
});
