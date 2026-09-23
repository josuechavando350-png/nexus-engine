import test from 'node:test';
import assert from 'node:assert/strict';
import {createIncrementalHomology,streamFilteredHomology,streamPointHomology,filteredSimplicialHomology,runMotor} from '../src/index.mjs';
const s=(vertices,value=0)=>({vertices,value});
const intervals=bars=>bars.map(b=>[b.dimension,b.birth,b.death]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('incremental tetrahedral sphere and filling match independent known H2 barcode and batch reduction',()=>{
  const vertices=[s([0]),s([1]),s([2]),s([3])],edges=[s([0,1],1),s([0,2],1),s([0,3],1),s([1,2],1),s([1,3],1),s([2,3],1)],faces=[s([0,1,2],2),s([0,1,3],2),s([0,2,3],2),s([1,2,3],2)];
  const e=createIncrementalHomology();e.append(vertices);e.append(edges);const sphere=e.append(faces);
  assert.deepEqual(sphere.bars.filter(b=>b.dimension===2).map(b=>[b.birth,b.death]),[[2,null]]);
  const filled=e.append([s([0,1,2,3],5)]);
  assert.equal(filled.newColumnsReduced,1);assert.equal(filled.reducedColumns,15);
  assert.deepEqual(filled.bars.filter(b=>b.dimension===2).map(b=>[b.birth,b.death]),[[2,5]]);
  assert.deepEqual(intervals(filled.bars),intervals(filteredSimplicialHomology({simplices:[...vertices,...edges,...faces,s([0,1,2,3],5)]}).bars));
});
test('failed append is atomic and snapshots cannot mutate stream state',()=>{
  const e=createIncrementalHomology();e.append([s([0]),s([1])]);const before=e.snapshot();
  assert.throws(()=>e.append([s([2],1),s([2,3],1)]),/face/);
  assert.deepEqual(e.snapshot(),before);
  assert.throws(()=>e.append([s([0],1)]),/duplicate/);
  assert.throws(()=>e.append([s([2],-1)]),/backwards/);
  const copy=e.snapshot();copy.bars[0].birthSimplex[0]=999;assert.deepEqual(e.snapshot(),before);
  assert.equal(e.append([s([0,1],1)]).simplexCount,3);
});
test('reduction budget and capacity failure preserve prior state',()=>{
  const e=createIncrementalHomology({maxOperations:1});e.append([s([0]),s([1])]);const before=e.snapshot();
  assert.throws(()=>e.append([s([0,1],1)]),/budget/);assert.deepEqual(e.snapshot(),before);
  const tiny=createIncrementalHomology({maxSimplices:1});tiny.append([s([0])]);assert.throws(()=>tiny.append([s([1])]),/capacity/);
});
test('multidimensional point stream creates then fills square H1 using only new columns',()=>{
  const events=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0.5,0.5,0]].map((point,time)=>({time,point}));
  const r=streamPointHomology({events,radius:1.01,maxHomology:2});
  assert.deepEqual(r.bars.filter(b=>b.dimension===1&&b.death>b.birth).map(b=>[b.birth,b.death]),[[3,4]]);
  assert.equal(r.updates.reduce((n,u)=>n+u.newColumnsReduced,0),r.simplexCount);
  assert.equal(r.updates[0].newColumnsReduced,1);
});
test('streaming strict contracts reject bad dimensions and decreasing time',()=>{
  assert.throws(()=>streamPointHomology({events:[{point:[0],time:1},{point:[1],time:0}],radius:1,maxHomology:1}),/backwards/);
  assert.throws(()=>streamPointHomology({events:[{point:[0],time:0},{point:[1,2],time:1}],radius:1,maxHomology:1}),/dimension/);
  assert.throws(()=>createIncrementalHomology({unknown:true}),/unknown/);
});
test('motor 70 integration exposes append-only filtered streaming',()=>{
  const payload={batches:[[s([0]),s([1])],[s([0,1],2)]]};
  assert.deepEqual(runMotor('70',{action:'filtered',payload}),streamFilteredHomology(payload));
  assert.equal(runMotor('70',{action:'filtered',payload}).bars.filter(b=>b.death===null).length,1);
});
