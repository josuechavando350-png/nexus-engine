import { exactIntegerPolynomialResultant } from './integer-polynomial-resultant.mjs';

const DECIMAL = /^-?(?:0|[1-9][0-9]*)$/u;
const MAX_DIGITS = 38; // The degree multiplier stays inside the resultant kernel's 40-digit input budget.

/** Discriminant over Z[x], using an exact derivative resultant, never floating point. */
export function exactIntegerPolynomialDiscriminant({ coefficients } = {}) {
  if (!Array.isArray(coefficients) || coefficients.length < 2 || coefficients.length > 7) {
    throw new RangeError('coefficients must have degree 1..6');
  }
  const f = coefficients.map((value, i) => {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new TypeError(`coefficients[${i}] must be an integer or canonical integer string`);
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new TypeError(`coefficients[${i}] must be an exact integer`);
    }
    const text = String(value);
    if (!DECIMAL.test(text) || text === '-0' || text.replace(/^-/, '').length > MAX_DIGITS) {
      throw new RangeError(`coefficients[${i}] exceeds exact decimal input budget`);
    }
    return BigInt(text);
  });
  const degree = f.length - 1;
  const leading = f[degree];
  if (leading === 0n) throw new RangeError('leading coefficient must be nonzero');
  // Every degree-one polynomial has discriminant 1 by convention.
  let discriminant = 1n;
  if (degree > 1) {
    const derivative = f.slice(1).map((coefficient, i) => coefficient * BigInt(i + 1));
    const resultant = BigInt(exactIntegerPolynomialResultant({
      left: f.map(String), right: derivative.map(String),
    }).resultant);
    if (resultant % leading !== 0n) throw new Error('polynomial discriminant division was not exact');
    discriminant = ((degree * (degree - 1) / 2) % 2 ? -resultant : resultant) / leading;
  }
  return Object.freeze({
    arithmetic: 'EXACT_INTEGER',
    degree,
    discriminant: discriminant.toString(),
    repeatedComplexRoot: discriminant === 0n,
  });
}
