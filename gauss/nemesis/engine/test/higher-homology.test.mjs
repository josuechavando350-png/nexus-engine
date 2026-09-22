import test from 'node:test';
import assert from 'node:assert/strict';
import {filteredSimplicialHomology,ripsHigherHomology} from '../src/motors/filtered-homology.mjs';
import {runMotor} from '../src/index.mjs';
const simplex=(vertices,value=0)=>({vertices,value});
function subsets(n,maxSize=n){const out=[];for(let mask=1;mask<(1<<n);mask++){const v=Array.from({length:n},(_,i)=>i).filter(i=>mask&(1<<i));if(v.length<=maxSize)out.push(simplex(v));}return out;}
const positive=bars=>bars.filter(b=>b.death===null||b.death>b.birth);

test('triangle loop born at 1 dies when face arrives at 2',()=>{
  const simplices=[simplex([0]),simplex([1]),simplex([2]),simplex([0,1],1),simplex([1,2],1),simplex([0,2],1),simplex([0,1,2],2)];
  const result=filteredSimplicialHomology({simplices:simplices.reverse()});
  assert.deepEqual(result.bars.filter(b=>b.dimension===1).map(b=>[b.birth,b.death]),[[1,2]]);
  assert.equal(result.bars.filter(b=>b.death===null).length,1);
});
test('boundaries of simplices have one top-dimensional sphere class H1 through H4',()=>{
  for(let n=3;n<=6;n++){
    const boundary=subsets(n,n-1);
    const bars=positive(filteredSimplicialHomology({simplices:boundary}).bars);
    assert.deepEqual(bars.map(b=>[b.dimension,b.death]),[[0,null],[n-2,null]]);
    boundary.push(simplex(Array.from({length:n},(_,i)=>i),3));
    const filled=positive(filteredSimplicialHomology({simplices:boundary}).bars);
    assert.deepEqual(filled.map(b=>[b.dimension,b.death]),[[0,null],[n-2,3]]);
  }
});
test('square Rips H1 is [1,sqrt(2)) and truncated radius is censored',()=>{
  const points=[[0,0],[1,0],[1,1],[0,1]];
  const result=ripsHigherHomology({points,maxHomology:1,maxRadius:2});
  assert.deepEqual(positive(result.bars).filter(b=>b.dimension===1).map(b=>[b.birth,b.death]),[[1,Math.SQRT2]]);
  const truncated=ripsHigherHomology({points,maxHomology:1,maxRadius:1.2});
  assert.equal(truncated.bars.find(b=>b.dimension===1).death,null);
});
test('invalid complex and exhausted work budget fail without partial results',()=>{
  assert.throws(()=>filteredSimplicialHomology({simplices:[simplex([0,1])]}),/missing a face/);
  assert.throws(()=>filteredSimplicialHomology({simplices:[simplex([0]),simplex([0])]}),/duplicate/);
  assert.throws(()=>filteredSimplicialHomology({simplices:[simplex([0],2),simplex([1]),simplex([0,1],1)]}),/filtration/);
  assert.throws(()=>filteredSimplicialHomology({simplices:subsets(4),maxOperations:1}),/budget/);
  assert.throws(()=>ripsHigherHomology({points:[[0],[0,1]],maxHomology:1,maxRadius:2}),/dimension/);
});
test('motor 27 exposes the higher-dimensional action',()=>{
  const result=runMotor('27',{action:'filtered',payload:{simplices:subsets(4,3)}});
  assert.ok(result.bars.some(b=>b.dimension===2&&b.death===null));
});
