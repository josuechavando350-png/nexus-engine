/**
 * Independent, deterministic reference checks for twelve finite-field GAUSS
 * operators. No GAUSS arithmetic or expected-value fixtures are imported.
 * This is an initial measured slice, NOT a 1,000-operator accuracy claim.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS, getGaussLayer} from '../core/registry.mjs';

const SEED = 0x4d3b7a91;
const CASES_PER_OPERATOR = 100;
const PRIMES = [2, 3, 5, 7, 11, 13];
const MOD = (value, p) => Number(((BigInt(value) % BigInt(p)) + BigInt(p)) % BigInt(p));
function normalize(values, prime) {
  const coefficients = values.map(value => MOD(value, prime));
  while (coefficients.length > 1 && coefficients.at(-1) === 0) coefficients.pop();
  return coefficients;
}
function polynomialValue(coefficients, at, prime) {
  // Direct evaluation by independent powers, not GAUSS's Horner evaluator.
  const p = BigInt(prime);
  let power = 1n;
  let total = 0n;
  for (const coefficient of coefficients) {
    total = (total + BigInt(coefficient) * power) % p;
    power = (power * BigInt(at)) % p;
  }
  return MOD(total, prime);
}
function coefficientsOfProduct(left, right, prime) {
  // Expand each monomial pair over BigInt; do not call the GAUSS multiplier.
  const terms = new Map();
  for (const [i, a] of left.entries()) {
    for (const [j, b] of right.entries()) {
      terms.set(i + j, (terms.get(i + j) ?? 0n) + BigInt(a) * BigInt(b));
    }
  }
  return normalize(Array.from({length: left.length + right.length - 1}, (_, k) => terms.get(k) ?? 0n), prime);
}
function inverse(coefficient, prime) {
  const value = MOD(coefficient, prime);
  for (let candidate = 1; candidate < prime; candidate += 1) {
    if (MOD(BigInt(candidate) * BigInt(value), prime) === 1) return candidate;
  }
  throw Error('reference inverse does not exist');
}

const DEFINITIONS = [
  {id: 'GAUSS.MATH.FP_NORMALIZE.676', make: ({prime, a}) => ({prime, coefficients: a}),
    expected: ({prime, a}) => ({coefficients: normalize(a, prime)})},
  {id: 'GAUSS.MATH.FP_DEGREE.677', make: ({prime, a}) => ({prime, coefficients: a}),
    expected: ({prime, a}) => {const n = normalize(a, prime); return {degree: n.length === 1 && n[0] === 0 ? null : n.length - 1};}},
  {id: 'GAUSS.MATH.FP_ADD.678', make: ({prime, a, b}) => ({prime, left: a, right: b}),
    expected: ({prime, a, b}) => ({coefficients: normalize(Array.from({length: Math.max(a.length, b.length)}, (_, i) => BigInt(a[i] ?? 0) + BigInt(b[i] ?? 0)), prime)})},
  {id: 'GAUSS.MATH.FP_SUBTRACT.679', make: ({prime, a, b}) => ({prime, left: a, right: b}),
    expected: ({prime, a, b}) => ({coefficients: normalize(Array.from({length: Math.max(a.length, b.length)}, (_, i) => BigInt(a[i] ?? 0) - BigInt(b[i] ?? 0)), prime)})},
  {id: 'GAUSS.MATH.FP_NEGATE.680', make: ({prime, a}) => ({prime, coefficients: a}),
    expected: ({prime, a}) => ({coefficients: normalize(a.map(value => -BigInt(value)), prime)})},
  {id: 'GAUSS.MATH.FP_SCALE.681', make: ({prime, a, scalar}) => ({prime, coefficients: a, scalar}),
    expected: ({prime, a, scalar}) => ({coefficients: normalize(a.map(value => BigInt(value) * BigInt(scalar)), prime)})},
  {id: 'GAUSS.MATH.FP_PRODUCT.682', make: ({prime, a, b}) => ({prime, left: a, right: b}),
    expected: ({prime, a, b}) => ({coefficients: coefficientsOfProduct(a, b, prime)})},
  {id: 'GAUSS.MATH.FP_DERIVATIVE.686', make: ({prime, a}) => ({prime, coefficients: a}),
    expected: ({prime, a}) => ({coefficients: normalize(a.length === 1 ? [0] : a.slice(1).map((value, i) => BigInt(value) * BigInt(i + 1)), prime)})},
  {id: 'GAUSS.MATH.FP_EVALUATE.689', make: ({prime, a, at}) => ({prime, coefficients: a, at}),
    expected: ({prime, a, at}) => ({value: polynomialValue(a, at, prime)})},
  {id: 'GAUSS.MATH.FP_MULTIPOINT_EVAL.690', make: ({prime, a, points}) => ({prime, coefficients: a, points}),
    expected: ({prime, a, points}) => ({values: points.map(at => polynomialValue(a, at, prime))})},
  {id: 'GAUSS.MATH.FP_ROOTS.695', make: ({prime, a}) => ({prime, coefficients: a}),
    expected: ({prime, a}) => ({roots: Array.from({length: prime}, (_, at) => at).filter(at => polynomialValue(a, at, prime) === 0)})},
  {id: 'GAUSS.MATH.FP_MONIC.685', make: ({prime, a}) => ({prime, coefficients: a}),
    expected: ({prime, a}) => {const normalized = normalize(a, prime); const factor = normalized.length === 1 && normalized[0] === 0 ? 0 : inverse(normalized.at(-1), prime); return {coefficients: normalize(normalized.map(value => BigInt(value) * BigInt(factor)), prime)};}},
];

function generator(seed) {
  let state = seed >>> 0;
  return max => {
    // xorshift32, explicitly non-cryptographic and deterministic.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
}
function inputCase(index, random) {
  const prime = PRIMES[(index + random(PRIMES.length)) % PRIMES.length];
  const coefficient = () => random(2001) - 1000;
  const lenA = 1 + random(7);
  const lenB = 1 + random(7);
  const a = Array.from({length: lenA}, coefficient);
  const b = Array.from({length: lenB}, coefficient);
  if (index % 11 === 0) a.fill(0); // Zero-polynomial corner cases.
  if (index % 13 === 0) b.fill(0);
  if (index % 7 === 0) a[a.length - 1] = 0; // Leading-zero normalization.
  if (index % 17 === 0) a[0] = -100000; // Contract boundary.
  return {prime, a, b, scalar: coefficient(), at: coefficient(), points: [coefficient(), coefficient(), coefficient(), 0]};
}
function invalidInputs(input) {
  const wrongPrime = {...input, prime: 4}; // 4 is composite, not a field.
  const wrongShape = {...input, unexpected: true};
  const wrongCoefficient = {...input};
  if ('coefficients' in input) wrongCoefficient.coefficients = [1.25];
  else wrongCoefficient.left = [1.25];
  return [wrongPrime, wrongShape, wrongCoefficient];
}
function failure(id, caseIndex, input, expected, actual, reason) {
  return {id, caseIndex, input, expected, actual, reason};
}

export function runFinitePolynomialBank({resolveLayer = getGaussLayer} = {}) {
  assert.equal(GAUSS_IMPLEMENTED_LAYERS.length, 1000, 'fixed registry denominator changed');
  assert.equal(new Set(DEFINITIONS.map(d => d.id)).size, DEFINITIONS.length, 'duplicate bank operator');
  const report = {
    schemaVersion: 1,
    subject: 'GAUSS finite-field polynomial operators',
    seed: `0x${SEED.toString(16)}`,
    oracle: 'separate BigInt integer/modular reference; no GAUSS expected values imported',
    registryOperators: 1000,
    coveredOperators: 0,
    untestedOperators: 1000,
    validCases: 0,
    passedValidCases: 0,
    failedValidCases: 0,
    invalidCases: 0,
    passedInvalidRejections: 0,
    failedInvalidRejections: 0,
    exactEquality: true,
    operatorResults: [],
    failures: [],
    caseDigest: '',
  };
  const caseHash = createHash('sha256');
  for (const definition of DEFINITIONS) {
    const layer = resolveLayer(definition.id);
    assert.equal(typeof layer?.execute, 'function', `missing actual operator ${definition.id}`);
    const seed = Number.parseInt(createHash('sha256').update(definition.id).digest('hex').slice(0, 8), 16) ^ SEED;
    const random = generator(seed);
    const item = {id: definition.id, validCases: 0, passed: 0, failed: 0, invalidCases: 0, rejected: 0, invalidAccepted: 0};
    for (let index = 0; index < CASES_PER_OPERATOR; index += 1) {
      const generated = inputCase(index, random);
      const input = definition.make(generated);
      const expected = definition.expected(generated);
      caseHash.update(JSON.stringify({id: definition.id, index, input, expected}));
      item.validCases += 1;
      report.validCases += 1;
      let actual;
      try {
        actual = layer.execute(structuredClone(input));
        assert.deepStrictEqual(actual, expected);
        item.passed += 1;
        report.passedValidCases += 1;
      } catch (error) {
        item.failed += 1;
        report.failedValidCases += 1;
        if (report.failures.length < 20) report.failures.push(failure(definition.id, index, input, expected, actual ?? null, String(error)));
      }
      if (index === 0) {
        for (const [invalidIndex, invalid] of invalidInputs(input).entries()) {
          item.invalidCases += 1;
          report.invalidCases += 1;
          try {
            const actual = layer.execute(structuredClone(invalid));
            item.invalidAccepted += 1;
            report.failedInvalidRejections += 1;
            if (report.failures.length < 20) report.failures.push(failure(definition.id, `invalid-${invalidIndex}`, invalid, 'rejection', actual, 'invalid input accepted'));
          } catch {
            item.rejected += 1;
            report.passedInvalidRejections += 1;
          }
        }
      }
    }
    report.operatorResults.push(item);
    report.coveredOperators += 1;
  }
  report.untestedOperators = report.registryOperators - report.coveredOperators;
  report.caseDigest = `sha256:${caseHash.digest('hex')}`;
  report.validPassRate = report.validCases ? report.passedValidCases / report.validCases : null;
  report.invalidRejectionRate = report.invalidCases ? report.passedInvalidRejections / report.invalidCases : null;
  return report;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = runFinitePolynomialBank();
  console.log(JSON.stringify(report, null, 2));
  if (report.failedValidCases || report.failedInvalidRejections) process.exitCode = 1;
}
