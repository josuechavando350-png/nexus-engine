import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MOTOR_REGISTRY } from '../src/motors/index.mjs';
const root=new URL('../',import.meta.url).pathname;
test('100-name inventory is exact, 97 bounded implementations plus 3 explicitly incomplete cryptographic primitives, no fake code path',()=>{
  const lines=readFileSync(join(root,'INVENTARIO_100.txt'),'utf8').trimEnd().split('\n');
  const rows=JSON.parse(readFileSync(join(root,'INVENTARIO_100.json'),'utf8'));
  assert.equal(lines.length,100);assert.equal(rows.length,100);
  assert.equal(new Set(lines).size,100);
  for(let i=0;i<100;i++){
    assert.equal(rows[i].numero,i+1);assert.equal(rows[i].nombre,lines[i]);
    if([81,89,95].includes(i+1)){assert.equal(rows[i].estado,'PRIMITIVA_ACOTADA_NO_CUMPLE_ESPECIFICACION');assert.ok(existsSync(join(root,rows[i].codigo)));}
    else{assert.equal(rows[i].estado,'IMPLEMENTACION_ACOTADA_PROBADA');assert.ok(existsSync(join(root,rows[i].codigo)));}
  }
  assert.deepEqual(Object.keys(MOTOR_REGISTRY).sort((a,b)=>Number(a)-Number(b)),Array.from({length:99},(_,i)=>String(i+2).padStart(2,'0')));
});
