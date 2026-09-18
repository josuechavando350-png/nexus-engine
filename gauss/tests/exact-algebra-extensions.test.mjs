import test from 'node:test';
import assert from 'node:assert/strict';
import { generalizedChineseRemainder as crt, finiteFieldMatrixInverse as inverse } from '../core/layers/exact-algebra-extensions.mjs';

function bruteCrt(congruences) {
  // Independent finite exhaustive search for small moduli; no Euclid/Bezout.
  let period = 1;
  while (!congruences.every(({modulus}) => period % Number(modulus) === 0)) period++;
  for (let candidate = 0; candidate < period; candidate++) {
    if (congruences.every(({remainder,modulus}) =>
      ((candidate-Number(remainder)) % Number(modulus) + Number(modulus)) % Number(modulus) === 0)) {
      return { consistent:true, remainder:String(candidate), modulus:String(period) };
    }
  }
  return { consistent:false, remainder:null, modulus:null };
}
function leibnizDet(matrix) {
  let sum = 0;
  function enumerate(row, columns, product, parity) {
    if (row === matrix.length) { sum += parity * product; return; }
    for (let j = 0; j < matrix.length; j++) {
      if (columns.includes(j)) continue;
      const swaps = columns.filter(previous => previous > j).length;
      enumerate(row+1, [...columns,j], product*matrix[row][j], parity*(swaps%2?-1:1));
    }
  }
  enumerate(0,[],1,1);
  return sum;
}
function assertBothProducts(matrix, result, prime) {
  const expected = Array.from({ length:matrix.length },(_,i)=>Array.from({length:matrix.length},(_,j)=>Number(i===j)));
  for (const [left,right] of [[matrix,result.inverse],[result.inverse,matrix]]) {
    const product = left.map(row=>row.map((_,j)=>
      ((row.reduce((sum,item,k)=>sum+item*right[k][j],0)%prime)+prime)%prime));
    assert.deepEqual(product, expected);
  }
}

test('generalized CRT handles noncoprime, negative, contradictory and modulus-one congruences', () => {
  assert.deepEqual(crt({congruences:[{remainder:2,modulus:4},{remainder:6,modulus:8},{remainder:5,modulus:9}]}),
    {consistent:true,remainder:'14',modulus:'72'});
  assert.deepEqual(crt({congruences:[{remainder:1,modulus:2},{remainder:0,modulus:2}]}),
    {consistent:false,remainder:null,modulus:null});
  assert.deepEqual(crt({congruences:[{remainder:'-2',modulus:'6'},{remainder:'4',modulus:'9'}]}),
    {consistent:true,remainder:'4',modulus:'18'});
  assert.deepEqual(crt({congruences:[{remainder:'-123',modulus:'1'}]}),
    {consistent:true,remainder:'0',modulus:'1'});
  const big = '9'.repeat(100);
  assert.deepEqual(crt({congruences:[{remainder:big,modulus:big}]}),
    {consistent:true,remainder:'0',modulus:big});
});

test('generalized CRT matches 240 independent bounded exhaustive oracles', () => {
  let state=0x12345678;
  const next=()=> {state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
  for(let i=0;i<240;i++) {
    const congruences=Array.from({length:1+i%3},()=>({remainder:Number(next()%33)-16,modulus:1+Number(next()%9)}));
    assert.deepEqual(crt({congruences}),bruteCrt(congruences),`case ${i}`);
  }
});

test('generalized CRT validates all inputs, blocks numeric rounding and bounds growth', () => {
  assert.throws(()=>crt({congruences:[]}),/1\.\.16/u);
  assert.throws(()=>crt({congruences:[{remainder:1,modulus:2},{remainder:0,modulus:2},{remainder:1.2,modulus:3}]}),/pre-rounded/u);
  assert.throws(()=>crt({congruences:[{remainder:0,modulus:0}]}),/positive/u);
  assert.throws(()=>crt({congruences:[{remainder:'01',modulus:3}]}),/canonical/u);
  assert.throws(()=>crt({congruences:[{remainder:'1e6',modulus:3}]}),/canonical/u);
  assert.throws(()=>crt({congruences:[{remainder:0,modulus:Number.MAX_SAFE_INTEGER+1}]}),/pre-rounded/u);
  assert.throws(()=>crt({congruences:[{remainder:0,modulus:3,extra:0}]}),/exactly/u);
  assert.throws(()=>crt({congruences:[{remainder:0,modulus:'9'.repeat(129)}]}),/bounded/u);
  assert.throws(()=>crt({congruences:Array.from({length:17},()=>({remainder:0,modulus:2}))}),/1\.\.16/u);
  const near128 = Array.from({length:16},(_,i)=>BigInt('9'.repeat(127))+BigInt(i*2+1));
  assert.throws(()=>crt({congruences:near128.map(m=>({remainder:0,modulus:m.toString()}))}),/budget/u);
});

test('finite-field matrix inverse returns exact canonical inverses and singular witnesses', () => {
  assert.deepEqual(inverse({prime:7,coefficients:[[1,2],[3,4]]}),
    {fieldPrime:7,invertible:true,inverse:[[5,1],[5,3]]});
  assert.deepEqual(inverse({prime:2,coefficients:[[0,1],[1,0]]}),
    {fieldPrime:2,invertible:true,inverse:[[0,1],[1,0]]});
  assert.deepEqual(inverse({prime:7,coefficients:[[2,4],[1,2]]}),
    {fieldPrime:7,invertible:false,inverse:null});
  assert.deepEqual(inverse({prime:7,coefficients:[[0]]}),
    {fieldPrime:7,invertible:false,inverse:null});
  assert.deepEqual(inverse({prime:7,coefficients:[[-1]]}),
    {fieldPrime:7,invertible:true,inverse:[[6]]});
  const big=Array.from({length:12},(_,i)=>Array.from({length:12},(_,j)=>i===j?1:j>i?2:0));
  assertBothProducts(big,inverse({prime:65521,coefficients:big}),65521);
});

test('finite-field inverses satisfy two independent products and a Leibniz singularity oracle on 250 seeded matrices', () => {
  let state=0xc0ffeeaa;
  const next=()=>{state=(Math.imul(state,1103515245)+12345)>>>0;return state;};
  for(let i=0;i<250;i++) {
    const n=1+i%4,prime=[2,3,5,7,11][i%5];
    const matrix=Array.from({length:n},()=>Array.from({length:n},()=>Number(next()%15)-7));
    const expectedInvertible=(((leibnizDet(matrix)%prime)+prime)%prime)!==0;
    const result=inverse({prime,coefficients:matrix});
    assert.equal(result.invertible,expectedInvertible,`case ${i}`);
    if(expectedInvertible) assertBothProducts(matrix,result,prime);
    else assert.equal(result.inverse,null);
  }
});

test('finite-field inverse rejects composite fields, malformed matrices and unsafe coefficients', () => {
  for(const prime of [0,1,4,9,65522,65537,2.5,'7'])
    assert.throws(()=>inverse({prime,coefficients:[[1]]}),/prime/u);
  assert.throws(()=>inverse({prime:7,coefficients:[]}),/1\.\.12/u);
  assert.throws(()=>inverse({prime:7,coefficients:[[1,2]]}),/square/u);
  assert.throws(()=>inverse({prime:7,coefficients:[[1.1]]}),/safe integer/u);
  assert.throws(()=>inverse({prime:7,coefficients:[[Number.MAX_SAFE_INTEGER+1]]}),/safe integer/u);
  assert.throws(()=>inverse({prime:7,coefficients:[[1000000001]]}),/bounded/u);
  assert.throws(()=>inverse({prime:7,coefficients:[[1]],extra:1}),/exactly/u);
});
