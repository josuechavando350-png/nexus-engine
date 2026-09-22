import test from 'node:test';
import assert from 'node:assert/strict';
import {runMotor,runNativeFheAdder,runMotorPipeline} from '../src/index.mjs';
test('89: native action exists in public registry; fails closed without executable',async()=>{
 assert.throws(()=>runMotor('89',{action:'native-add-u8',a:255,b:255,binary:'/no/such/nemesis-fhe'}),/executable unavailable/);
 assert.throws(()=>runNativeFheAdder({action:'native-add-u8',a:256,b:0}),/unsigned byte/);
 assert.throws(()=>runNativeFheAdder({action:'native-add-u8',a:1.5,b:0}),/unsigned byte/);
 const result=await runMotorPipeline({tasks:[{id:'fhe',motor:'89',input:{action:'native-add-u8',a:1,b:2,binary:'/no/such/nemesis-fhe'}}]});
 assert.equal(result.status,'BLOCKED');assert.equal(result.tasks.length,0);
});

import {compileNativeFheCircuit,runNativeFheCircuit} from '../src/index.mjs';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

test('89: compile general Boolean DAG with independent expected result (no native proof claimed)',()=>{
 const input={action:'native-circuit',inputs:[true,false,true],gates:[
  {op:'xor',a:0,b:1},{op:'mux',s:2,a:3,b:1},
  {op:'not',a:4},{op:'and',a:0,b:2},{op:'or',a:1,b:2},
  {op:'nand',a:0,b:2},{op:'nor',a:0,b:2},{op:'xnor',a:0,b:2}],
  outputs:[3,4,5,6,7,8,9,10,0]};
 const compiled=compileNativeFheCircuit(input);
 assert.deepEqual(compiled.args,['--circuit-stdin','xor:0:1;mux:2:3:1;not:4;and:0:2;or:1:2;nand:0:2;nor:0:2;xnor:0:2','3,4,5,6,7,8,9,10,0']);
 assert.equal(Object.hasOwn(compiled,'secretStdin'),false);assert.equal(compiled.args.join(' ').includes('101'),false);
 assert.deepEqual(compiled.expected,[true,true,false,true,true,false,false,true,true]);
 assert.match(compiled.circuitSha256,/^[0-9a-f]{64}$/);
});
test('89: general Boolean circuit refuses malformed DAGs before native execution',()=>{
 const base={action:'native-circuit',inputs:[true,false],gates:[{op:'xor',a:0,b:1}],outputs:[2],binary:'/nonexistent'};
 assert.throws(()=>runNativeFheCircuit(base),/executable unavailable/);
 const invalid=[
  {gates:[{op:'xor',a:0,b:2}]}, {gates:[{op:'mux',s:0,a:1,b:3}]},
  {gates:[{op:'not',a:-1}]}, {gates:[{op:'xor',a:0,b:1,extra:0}]},
  {gates:[{op:'bogus',a:0}]}, {gates:[{op:'and',a:0}]},
  {inputs:[1,false]}, {inputs:[]}, {outputs:[4]}, {outputs:[]},
  {gates:Array.from({length:2049},()=>({op:'not',a:0}))},
  {inputs:Array.from({length:129},()=>false)}, {outputs:Array.from({length:129},()=>0)},
 ];
 for(const replacement of invalid)assert.throws(()=>compileNativeFheCircuit({...base,...replacement}),undefined,JSON.stringify(replacement).slice(0,70));
});
test('89: rejects compromised executable pin and fraudulent native answers (negative contract only)',()=>{
 if(process.platform==='win32')return;
 const dir=mkdtempSync(join(tmpdir(),'nemesis89-contract-'));
 try{
  const binary=join(dir,'bad-backend');
  writeFileSync(binary,'#!/bin/sh\nprintf \'%s\\n\' \'{"motor":89,"backend":"TFHE_BOOLEAN","outputs":[false],"verified":true}\'\n');
  chmodSync(binary,0o700);
  const circuit={action:'native-circuit',inputs:[true,true],gates:[{op:'and',a:0,b:1}],outputs:[2],binary};
  assert.throws(()=>runNativeFheCircuit({...circuit,expectedBinarySha256:'0'.repeat(64)}),/trusted binary pin/);
  assert.throws(()=>runNativeFheCircuit(circuit),/independent circuit consistency/);
  const digest=createHash('sha256').update(readFileSync(binary)).digest('hex');
  assert.throws(()=>runNativeFheCircuit({...circuit,expectedBinarySha256:digest}),/independent circuit consistency/);
  assert.throws(()=>runNativeFheAdder({action:'native-add-u8',a:1,b:1,binary}),/independent addition consistency/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
