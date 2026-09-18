/** AXIOMA: independent exhaustive references for the 25 bounded permutation operators. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS, getGaussLayer} from '../core/registry.mjs';

const SEED = 0x7a19d32b;
const CASES_PER_OPERATOR = 100;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const identity = n => Array.from({length: n}, (_, i) => i);
const applied = (a, b) => b.map(v => a[v]); // composition by direct function evaluation
const reverseLookup = a => identity(a.length).map(value => a.indexOf(value));
const bigintFactorial = n => identity(n).reduce((v, i) => v * BigInt(i + 1), 1n);
function enumerate(n) {
  const output = [];
  const visit = (prefix, available) => {
    if (!available.length) {output.push(prefix); return;}
    for (const value of available) visit([...prefix, value], available.filter(v => v !== value));
  };
  visit([], identity(n));
  return output;
}
const allBySize = new Map(identity(6).map(i => [i + 1, enumerate(i + 1)]));
const lexRank = (a, all) => all.findIndex(row => same(a, row));
function cycleLists(a) {
  const done = new Set();
  const cycles = [];
  for (const start of identity(a.length)) {
    if (done.has(start)) continue;
    const cycle = [];
    let cursor = start;
    while (!done.has(cursor)) {done.add(cursor); cycle.push(cursor); cursor = a[cursor];}
    cycles.push(cycle);
  }
  return cycles;
}
function repeat(a, exponent) {
  let result = identity(a.length);
  const base = exponent < 0 ? reverseLookup(a) : a;
  for (let i = 0; i < Math.abs(exponent); i += 1) result = applied(base, result);
  return result;
}
function order(a) {
  let cursor = identity(a.length);
  for (let exponent = 1; exponent <= Number(bigintFactorial(a.length)); exponent += 1) {
    cursor = applied(a, cursor);
    if (same(cursor, identity(a.length))) return exponent;
  }
  throw Error('independent order enumeration exceeded n!');
}
function parity(a) {
  const values = a.slice();
  let swaps = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === i) continue;
    const j = values.indexOf(i);
    [values[i], values[j]] = [values[j], values[i]];
    swaps += 1;
  }
  return swaps % 2 ? -1 : 1;
}
const invertedPairs = a => a.flatMap((v, i) => a.slice(i + 1).filter(w => v > w)).length;
const down = a => identity(a.length - 1).filter(i => a[i] > a[i + 1]);
const up = a => identity(a.length - 1).filter(i => a[i] < a[i + 1]);
function conjugate(a, b) {return applied(applied(b, a), reverseLookup(b));}
function orbit(a, point) {
  const out = [], seen = new Set();
  for (let cursor = point; !seen.has(cursor); cursor = a[cursor]) {out.push(cursor); seen.add(cursor);}
  return out;
}
const definition = (tag, make, expected) => ({id: `GAUSS.MATH.${tag}.${526 + TAGS.indexOf(tag)}`, make, expected});
const TAGS = [
  'PERM_INVERSE', 'PERM_COMPOSE', 'PERM_POWER', 'PERM_CYCLE_DECOMP', 'PERM_CYCLE_TYPE',
  'PERM_ORDER', 'PERM_SIGN', 'PERM_INVERSIONS', 'PERM_MAJOR_INDEX', 'PERM_DESCENTS',
  'PERM_ASCENTS', 'PERM_FIXED_POINTS', 'PERM_EXCEDANCES', 'PERM_LEFT_RECORDS', 'PERM_LEHMER_CODE',
  'PERM_LEX_RANK', 'PERM_LEX_UNRANK', 'PERM_LEX_NEXT', 'PERM_LEX_PREV', 'PERM_POINT_ORBIT',
  'PERM_CONJUGATE', 'PERM_COMMUTATOR', 'PERM_CENTRALIZER_SIZE', 'PERM_CONJUGACY_CLASS', 'PERM_CYCLE_INDEX_MONOMIAL',
];
const single = v => ({permutation: v.a});
const pair = v => ({left: single(v), right: {permutation: v.b}});
const DEFINITIONS = [
  definition('PERM_INVERSE', single, v => ({permutation: reverseLookup(v.a)})),
  definition('PERM_COMPOSE', pair, v => ({permutation: applied(v.a, v.b)})),
  definition('PERM_POWER', v => ({...single(v), exponent: v.exponent}), v => ({permutation: repeat(v.a, v.exponent)})),
  definition('PERM_CYCLE_DECOMP', single, v => ({cycles: cycleLists(v.a)})),
  definition('PERM_CYCLE_TYPE', single, v => ({lengths: cycleLists(v.a).map(c => c.length).sort((a, b) => b - a)})),
  definition('PERM_ORDER', single, v => ({order: order(v.a)})),
  definition('PERM_SIGN', single, v => ({sign: parity(v.a)})),
  definition('PERM_INVERSIONS', single, v => ({count: invertedPairs(v.a)})),
  definition('PERM_MAJOR_INDEX', single, v => ({index: down(v.a).reduce((s, i) => s + i + 1, 0)})),
  definition('PERM_DESCENTS', single, v => ({indices: down(v.a)})),
  definition('PERM_ASCENTS', single, v => ({indices: up(v.a)})),
  definition('PERM_FIXED_POINTS', single, v => ({indices: identity(v.a.length).filter(i => v.a[i] === i)})),
  definition('PERM_EXCEDANCES', single, v => ({indices: identity(v.a.length).filter(i => v.a[i] > i)})),
  definition('PERM_LEFT_RECORDS', single, v => ({indices: identity(v.a.length).filter(i => v.a[i] === Math.max(...v.a.slice(0, i + 1)))})),
  definition('PERM_LEHMER_CODE', single, v => ({digits: v.a.map((value, i) => v.a.slice(i + 1).filter(other => other < value).length)})),
  definition('PERM_LEX_RANK', single, v => ({rank: String(lexRank(v.a, v.all))})),
  definition('PERM_LEX_UNRANK', v => ({size: v.a.length, rank: String(v.rank)}), v => ({permutation: v.all[v.rank]})),
  definition('PERM_LEX_NEXT', single, v => ({permutation: v.all[lexRank(v.a, v.all) + 1] ?? null})),
  definition('PERM_LEX_PREV', single, v => ({permutation: v.all[lexRank(v.a, v.all) - 1] ?? null})),
  definition('PERM_POINT_ORBIT', v => ({...single(v), point: v.point}), v => ({orbit: orbit(v.a, v.point)})),
  definition('PERM_CONJUGATE', v => ({...single(v), by: v.b}), v => ({permutation: conjugate(v.a, v.b)})),
  definition('PERM_COMMUTATOR', pair, v => ({permutation: applied(applied(applied(v.a, v.b), reverseLookup(v.a)), reverseLookup(v.b))})),
  definition('PERM_CENTRALIZER_SIZE', single, v => ({size: String(v.all.filter(b => same(applied(v.a, b), applied(b, v.a))).length)})),
  definition('PERM_CONJUGACY_CLASS', single, v => ({size: String(new Set(v.all.map(b => conjugate(v.a, b).join(','))).size)})),
  definition('PERM_CYCLE_INDEX_MONOMIAL', single, v => ({exponents: identity(v.a.length).map(i => cycleLists(v.a).filter(c => c.length === i + 1).length)})),
];
function randomSource(seed) {
  let state = seed >>> 0;
  return max => {state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max;};
}
function makeCase(index, random) {
  const n = 1 + random(6), all = allBySize.get(n);
  const rank = index % 17 === 0 ? 0 : index % 19 === 0 ? all.length - 1 : random(all.length);
  const a = all[rank];
  const b = all[index % 23 === 0 ? 0 : random(all.length)];
  return {a, b, all, rank, point: random(n), exponent: index % 13 === 0 ? -100 : random(19) - 9};
}
function invalidInputs(input) {
  const extra = {...input, unexpected: true};
  if ('size' in input) return [extra, {...input, rank: '01'}, {...input, rank: String(bigintFactorial(input.size))}];
  if ('left' in input) return [extra, {...input, left: {permutation: []}}, {...input, right: {permutation: [0, 0]}}];
  if ('by' in input) return [extra, {...input, by: []}, {...input, by: [0, 0]}];
  if ('point' in input) return [extra, {...input, point: input.permutation.length}, {...input, permutation: []}];
  if ('exponent' in input) return [extra, {...input, exponent: 0.5}, {...input, permutation: []}];
  return [extra, {...input, permutation: []}, {...input, permutation: 'not-an-array'}];
}
export function runPermutationBank({resolveLayer = getGaussLayer} = {}) {
  assert.equal(GAUSS_IMPLEMENTED_LAYERS.length, 1000, 'fixed GAUSS denominator changed');
  assert.deepEqual(DEFINITIONS.map(d => d.id), TAGS.map((tag, i) => `GAUSS.MATH.${tag}.${526 + i}`));
  const report = {
    schemaVersion: 1, bank: 'AXIOMA', domain: 'exact bounded permutations',
    seed: `0x${SEED.toString(16)}`, oracle: 'independent complete S_n enumeration (n <= 6); no GAUSS arithmetic helpers',
    registryOperators: 1000, coveredOperators: 0, untestedOperators: 1000,
    validCases: 0, passedValidCases: 0, failedValidCases: 0, invalidCases: 0,
    passedInvalidRejections: 0, failedInvalidRejections: 0, exactEquality: true,
    operatorResults: [], failures: [], caseDigest: '',
  };
  const hash = createHash('sha256');
  for (const entry of DEFINITIONS) {
    const layer = resolveLayer(entry.id);
    assert.equal(typeof layer?.execute, 'function', `missing real operator ${entry.id}`);
    const random = randomSource(Number.parseInt(createHash('sha256').update(entry.id).digest('hex').slice(0, 8), 16) ^ SEED);
    const item = {id: entry.id, validCases: 0, passed: 0, failed: 0, invalidCases: 0, rejected: 0, invalidAccepted: 0};
    for (let index = 0; index < CASES_PER_OPERATOR; index += 1) {
      const generated = makeCase(index, random), input = entry.make(generated), expected = entry.expected(generated);
      hash.update(JSON.stringify({id: entry.id, index, input, expected}));
      item.validCases++; report.validCases++;
      let actual;
      try {
        actual = layer.execute(structuredClone(input));
        assert.deepStrictEqual(actual, expected);
        item.passed++; report.passedValidCases++;
      } catch (error) {
        item.failed++; report.failedValidCases++;
        if (report.failures.length < 20) report.failures.push({id: entry.id, index, input, expected, actual: actual ?? null, error: String(error)});
      }
      if (index !== 0) continue;
      for (const [invalidIndex, bad] of invalidInputs(input).entries()) {
        item.invalidCases++; report.invalidCases++;
        try {
          const observed = layer.execute(structuredClone(bad));
          item.invalidAccepted++; report.failedInvalidRejections++;
          if (report.failures.length < 20) report.failures.push({id: entry.id, index: `invalid-${invalidIndex}`, input: bad, expected: 'reject', actual: observed});
        } catch {
          item.rejected++; report.passedInvalidRejections++;
        }
      }
    }
    report.operatorResults.push(item); report.coveredOperators++;
  }
  report.untestedOperators = report.registryOperators - report.coveredOperators;
  report.caseDigest = `sha256:${hash.digest('hex')}`;
  report.validPassRate = report.validCases ? report.passedValidCases / report.validCases : null;
  report.invalidRejectionRate = report.invalidCases ? report.passedInvalidRejections / report.invalidCases : null;
  return report;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = runPermutationBank();
  console.log(JSON.stringify(report, null, 2));
  if (report.failedValidCases || report.failedInvalidRejections) process.exitCode = 1;
}
