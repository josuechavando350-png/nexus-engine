/**
 * Exact cyclic-kernel Vélu isogenies over small prime fields for mathematical
 * verification. Variable-time and publicly enumerable: NEVER use with keys,
 * signatures or secrets. This does not implement SQIsign.
 */

const mod = (n, p) => ((n % p) + p) % p;
function integer(n, label, lo, hi) {
  if (!Number.isSafeInteger(n) || n < lo || n > hi)
    throw new TypeError(`${label} must be an integer in [${lo}, ${hi}]`);
  return n;
}
function object(value, label, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)))
    throw new TypeError(`${label}: invalid object or unexpected field`);
}
function isPrime(n) {
  if (n < 5 || n % 2 === 0) return false;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}
function inverse(n, p) {
  const a = mod(n, p);
  if (a === 0) throw new RangeError('inverse of zero');
  let [r, nr, t, nt] = [p, a, 0, 1];
  while (nr !== 0) {
    const q = Math.floor(r / nr);
    [r, nr] = [nr, r - q * nr];
    [t, nt] = [nt, t - q * nt];
  }
  if (r !== 1) throw new RangeError('not invertible');
  return mod(t, p);
}
function equal(P, Q) {
  return P === null ? Q === null : Q !== null && P.x === Q.x && P.y === Q.y;
}
function point(P, label, p, a, b) {
  if (P === null) return null;
  object(P, label, ['x', 'y']);
  if (Object.keys(P).length !== 2 || !Object.hasOwn(P, 'x') || !Object.hasOwn(P, 'y'))
    throw new TypeError(`${label}: expected {x,y} or null`);
  const x = integer(P.x, `${label}.x`, 0, p - 1);
  const y = integer(P.y, `${label}.y`, 0, p - 1);
  if (mod(y * y - x * x * x - a * x - b, p) !== 0)
    throw new TypeError(`${label}: point not on source curve`);
  return {x, y};
}
function add(P, Q, a, p) {
  if (P === null) return Q;
  if (Q === null) return P;
  if (P.x === Q.x && mod(P.y + Q.y, p) === 0) return null;
  const slope = equal(P, Q)
    ? mod((3 * P.x * P.x + a) * inverse(2 * P.y, p), p)
    : mod((Q.y - P.y) * inverse(Q.x - P.x, p), p);
  const x = mod(slope * slope - P.x - Q.x, p);
  return {x, y: mod(slope * (P.x - x) - P.y, p)};
}

/**
 * Calculate a normalized separable cyclic degree-n Vélu map.
 * Input: {p,a,b,degree,generator:{x,y},points:[{x,y}|null,...]}.
 * The generator is REQUIRED to have exact order `degree`; the subgroup is
 * constructed and checked internally. This is educational finite arithmetic,
 * not a signature, a cryptographic parameter set, or a constant-time routine.
 */
export function evaluateCyclicVelu(input) {
  object(input, 'input', ['p', 'a', 'b', 'degree', 'generator', 'points']);
  if (Object.keys(input).length !== 6 ||
      ['p', 'a', 'b', 'degree', 'generator', 'points'].some(k => !Object.hasOwn(input, k)))
    throw new TypeError('expected {p,a,b,degree,generator,points}');
  const p = integer(input.p, 'p', 5, 1009);
  if (!isPrime(p)) throw new TypeError('p must be an odd prime between 5 and 1009');
  const a = integer(input.a, 'a', 0, p - 1);
  const b = integer(input.b, 'b', 0, p - 1);
  if (mod(4 * a * a * a + 27 * b * b, p) === 0)
    throw new TypeError('singular source curve');
  const degree = integer(input.degree, 'degree', 2, 31);
  const generator = point(input.generator, 'generator', p, a, b);
  if (generator === null) throw new TypeError('generator cannot be infinity');
  if (!Array.isArray(input.points) || input.points.length > 128)
    throw new TypeError('points must be an array with at most 128 elements');
  const points = input.points.map((P, i) => point(P, `points[${i}]`, p, a, b));
  const kernel = [];
  let current = null;
  for (let i = 1; i <= degree; i++) {
    current = add(current, generator, a, p);
    if (i < degree && current === null)
      throw new TypeError('generator order is smaller than the declared degree');
    if (i === degree && current !== null)
      throw new TypeError('generator does not have the declared degree');
    if (i < degree) kernel.push(current);
  }
  // Summing every nonzero kernel member (including inverse pairs) gives the
  // Vélu short-Weierstrass coefficients without dividing by kernel order.
  let t = 0, w = 0;
  for (const Q of kernel) {
    t = mod(t + 3 * Q.x * Q.x + a, p);
    w = mod(w + 5 * Q.x * Q.x * Q.x + 3 * a * Q.x + 2 * b, p);
  }
  const targetA = mod(a - 5 * t, p);
  const targetB = mod(b - 7 * w, p);
  if (mod(4 * targetA ** 3 + 27 * targetB ** 2, p) === 0)
    throw new Error('Vélu target curve is singular');
  const images = points.map(P => {
    if (P === null || kernel.some(Q => equal(P, Q))) return null;
    let x = P.x, y = P.y;
    for (const Q of kernel) {
      const S = add(P, Q, a, p);
      if (S === null) throw new Error('unexpected kernel collision');
      x = mod(x + S.x - Q.x, p);
      y = mod(y + S.y - Q.y, p);
    }
    if (mod(y * y - x * x * x - targetA * x - targetB, p) !== 0)
      throw new Error('Vélu image is not on codomain');
    return {x, y};
  });
  return {
    domain: 'VELU_CYCLIC_SMALL_FIELD_NOT_SIGNATURE',
    degree,
    source: {p, a, b},
    target: {p, a: targetA, b: targetB},
    kernel: {generator, points: kernel},
    images,
    warning: 'Finite-field public algebra only; no signature, keys, post-quantum security or constant-time operations.'
  };
}
