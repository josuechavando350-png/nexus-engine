import assert from 'node:assert/strict';
import test from 'node:test';
import { solveFiniteBimatrixGame } from '../advanced/game-theory.mjs';

const solve = (a, b) => solveFiniteBimatrixGame({ rowPayoffs: a, columnPayoffs: b });

function independentlyPure(a, b) {
  const result = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[0].length; j++) {
    if (a[i][j] === Math.max(...a.map((row) => row[j])) && b[i][j] === Math.max(...b[i])) result.push([i, j]);
  }
  return result;
}

test('matching pennies: no pure equilibrium and exact 50:50 mixed equilibrium', () => {
  const r = solve([[1, -1], [-1, 1]], [[-1, 1], [1, -1]]);
  assert.deepEqual(r.pureEquilibria, []);
  assert.deepEqual(r.interiorMixedEquilibrium, {
    rowStrategy: ['1/2', '1/2'], columnStrategy: ['1/2', '1/2'],
    expectedRowPayoff: '0/1', expectedColumnPayoff: '0/1',
  });
  assert.equal(r.mixedEquilibriaComplete, false);
});

test('coordination game includes two pure equilibria plus exact interior mixing', () => {
  const r = solve([[4, 0], [0, 2]], [[4, 0], [0, 2]]);
  assert.deepEqual(r.pureEquilibria.map((p) => [p.row, p.column]), [[0, 0], [1, 1]]);
  assert.deepEqual(r.interiorMixedEquilibrium.rowStrategy, ['1/3', '2/3']);
  assert.deepEqual(r.interiorMixedEquilibrium.columnStrategy, ['1/3', '2/3']);
  assert.equal(r.interiorMixedEquilibrium.expectedRowPayoff, '4/3');
});

test('strictly dominant-strategy game returns its unique pure equilibrium', () => {
  const r = solve([[3, 0], [5, 1]], [[3, 5], [0, 1]]);
  assert.deepEqual(r.pureEquilibria, [{ row: 1, column: 1, rowPayoff: 1, columnPayoff: 1 }]);
  assert.equal(r.interiorMixedEquilibrium, null);
});

test('rectangular 3x2 pure equilibria are complete without inventing mixed solutions', () => {
  const a = [[2, 0], [1, 3], [0, 0]];
  const b = [[1, 0], [0, 2], [3, 3]];
  const r = solve(a, b);
  assert.deepEqual(r.pureEquilibria.map((p) => [p.row, p.column]), independentlyPure(a, b));
  assert.equal(r.evaluatedPureProfiles, 6);
  assert.equal(r.pureEquilibriaComplete, true);
  assert.equal(r.interiorMixedEquilibrium, null);
  assert.equal(r.mixedEquilibriaComplete, false);
});

test('rejects unsafe payoff values, uneven matrices and non-rectangular input', () => {
  assert.throws(() => solve([[1, 2], [2, NaN]], [[1, 1], [1, 1]]), /safe integer/);
  assert.throws(() => solve([[1, 2], [2, 3]], [[1, 2], [3]]), /rectangular/);
  assert.throws(() => solve([[1, 2], [2, 3]], [[1, 2, 3], [4, 5, 6]]), /dimensions/);
  assert.throws(() => solve([[1, 2], [2, 1_000_001]], [[1, 1], [1, 1]]), /safe integer/);
  assert.throws(() => solve([[1, , 2], [2, 3, 4]], [[1, 1, 1], [1, 1, 1]]), /dense/);
});

test('independent oracle checks all pure equilibria and mixed best-response ties in 200 deterministic random games', () => {
  let seed = 0xBADA55;
  function draw() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 15 - 7; }
  for (let trial = 0; trial < 200; trial++) {
    const a = [[draw(), draw()], [draw(), draw()]];
    const b = [[draw(), draw()], [draw(), draw()]];
    const r = solve(a, b);
    assert.deepEqual(r.pureEquilibria.map((p) => [p.row, p.column]), independentlyPure(a, b));
    if (r.interiorMixedEquilibrium !== null) {
      const p = Number(r.interiorMixedEquilibrium.rowStrategy[0].split('/')[0]) / Number(r.interiorMixedEquilibrium.rowStrategy[0].split('/')[1]);
      const q = Number(r.interiorMixedEquilibrium.columnStrategy[0].split('/')[0]) / Number(r.interiorMixedEquilibrium.columnStrategy[0].split('/')[1]);
      assert(p > 0 && p < 1 && q > 0 && q < 1);
      const row0 = q * a[0][0] + (1 - q) * a[0][1];
      const row1 = q * a[1][0] + (1 - q) * a[1][1];
      const col0 = p * b[0][0] + (1 - p) * b[1][0];
      const col1 = p * b[0][1] + (1 - p) * b[1][1];
      assert(Math.abs(row0 - row1) < 1e-10 && Math.abs(col0 - col1) < 1e-10);
    }
  }
});
