// Bounded exact integer geometry, except explicitly named Euclidean measurements.
// Coordinates are safe integers in [-100000, 100000]; cross/dot arithmetic stays exact.
const integer = (v, label, lo = -100000, hi = 100000) => {
  if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new TypeError(`${label} must be a bounded safe integer`);
  return v;
};
const point = (p, label) => {
  if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${label} must be a point [x,y]`);
  return [integer(p[0], `${label}.x`), integer(p[1], `${label}.y`)];
};
const points = (data, name, min = 1, max = 64) => {
  if (!Array.isArray(data) || data.length < min || data.length > max) throw new TypeError(`${name} count out of bounds`);
  return data.map((p, i) => point(p, `${name}[${i}]`));
};
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const squared = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const sort = (a, b) => a[0] - b[0] || a[1] - b[1];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const freeze = v => Object.freeze(v);
const freezePoints = arr => freeze(arr.map(p => freeze(p)));
const onSegment = (a, b, q) => cross(a, b, q) === 0 &&
  Math.min(a[0], b[0]) <= q[0] && q[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= q[1] && q[1] <= Math.max(a[1], b[1]);
function relation(a, b, c, d) {
  if (same(a, b) || same(c, d)) throw new TypeError('segments must have distinct endpoints');
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC === 0 && abD === 0) {
    const shared = [a, b, c, d].filter(q => onSegment(a, b, q) && onSegment(c, d, q));
    if (!shared.length) return 'DISJOINT';
    return shared.some((q, i) => shared.some((r, j) => j > i && !same(q, r))) ? 'OVERLAP' : 'TOUCH';
  }
  if (abC * abD < 0 && cdA * cdB < 0) return 'PROPER_CROSS';
  if (abC === 0 && onSegment(a, b, c) || abD === 0 && onSegment(a, b, d) ||
      cdA === 0 && onSegment(c, d, a) || cdB === 0 && onSegment(c, d, b)) return 'TOUCH';
  return 'DISJOINT';
}
function simplePolygon(data, min = 3, max = 32) {
  const poly = points(data, 'vertices', min, max), n = poly.length;
  const uniq = new Set(poly.map(p => p.join(',')));
  if (uniq.size !== n) throw new TypeError('polygon vertices must be unique');
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const adjacent = j === i + 1 || i === 0 && j === n - 1;
    if (adjacent) continue;
    if (relation(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n]) !== 'DISJOINT') {
      throw new TypeError('polygon must be simple with no self intersections');
    }
  }
  const area2 = poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * p[1], 0);
  if (area2 === 0) throw new TypeError('polygon must have nonzero signed area');
  return { poly, area2 };
}
function strictlyConvexCCW(data) {
  const { poly, area2 } = simplePolygon(data, 3, 24);
  if (area2 <= 0 || poly.some((p, i) => cross(p, poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]) <= 0)) {
    throw new TypeError('polygon must be strictly convex and counterclockwise');
  }
  return poly;
}
export function signedOrientation({ a, b, c }) {
  const p = point(a, 'a'), q = point(b, 'b'), r = point(c, 'c'), twiceSignedArea = cross(p, q, r);
  return freeze({ twiceSignedArea, orientation: Math.sign(twiceSignedArea) });
}
export function segmentIntersectionClass({ a, b, c, d }) {
  return freeze({ relation: relation(point(a, 'a'), point(b, 'b'), point(c, 'c'), point(d, 'd')) });
}
export function convexHullMonotone({ vertices }) {
  const ps = points(vertices, 'vertices', 1, 64).sort(sort).filter((p, i, a) => i === 0 || !same(p, a[i - 1]));
  if (ps.length <= 2) return freeze({ hull: freezePoints(ps), count: ps.length });
  const build = seq => { const h = []; for (const p of seq) { while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } return h; };
  const lower = build(ps), upper = build([...ps].reverse()), hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return freeze({ hull: freezePoints(hull), count: hull.length });
}
export function polygonSignedArea({ vertices }) {
  const { area2 } = simplePolygon(vertices);
  return freeze({ twiceSignedArea: area2, area: area2 / 2, absoluteArea: Math.abs(area2) / 2 });
}
export function polygonCentroid({ vertices }) {
  const { poly, area2 } = simplePolygon(vertices);
  let x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], w = p[0] * q[1] - q[0] * p[1];
    x += (p[0] + q[0]) * w; y += (p[1] + q[1]) * w;
  }
  return freeze({ centroid: freeze([x / (3 * area2), y / (3 * area2)]), twiceSignedArea: area2 });
}
export function polygonPerimeter({ vertices }) {
  const { poly } = simplePolygon(vertices);
  const perimeter = poly.reduce((s, p, i) => s + Math.hypot(p[0] - poly[(i + 1) % poly.length][0], p[1] - poly[(i + 1) % poly.length][1]), 0);
  return freeze({ perimeter, edges: poly.length });
}
export function pointInSimplePolygon({ vertices, query }) {
  const { poly } = simplePolygon(vertices), q = point(query, 'query'); let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (onSegment(a, b, q)) return freeze({ location: 'BOUNDARY' });
    if ((a[1] > q[1]) !== (b[1] > q[1])) {
      // Exact orientation determines whether the horizontal ray crosses the edge.
      const determinant = cross(a, b, q);
      if ((b[1] > a[1] && determinant > 0) || (b[1] < a[1] && determinant < 0)) inside = !inside;
    }
  }
  return freeze({ location: inside ? 'INSIDE' : 'OUTSIDE' });
}
export function closestPairSquared({ vertices }) {
  const ps = points(vertices, 'vertices', 2, 128);
  let best = Infinity, pair = [0, 1];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const d = squared(ps[i], ps[j]); if (d < best) { best = d; pair = [i, j]; }
  }
  return freeze({ distanceSquared: best, indices: freeze(pair) });
}
export function farthestPairSquared({ vertices }) {
  const ps = points(vertices, 'vertices', 2, 128);
  let best = -1, pair = [0, 1];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const d = squared(ps[i], ps[j]); if (d > best) { best = d; pair = [i, j]; }
  }
  return freeze({ distanceSquared: best, indices: freeze(pair) });
}
export function pointSegmentProjection({ a, b, query }) {
  const p = point(a, 'a'), q = point(b, 'b'), x = point(query, 'query');
  if (same(p, q)) throw new TypeError('segment must have distinct endpoints');
  const dx = q[0] - p[0], dy = q[1] - p[1], denom = dx * dx + dy * dy;
  const parameter = Math.max(0, Math.min(1, ((x[0] - p[0]) * dx + (x[1] - p[1]) * dy) / denom));
  const foot = [p[0] + parameter * dx, p[1] + parameter * dy];
  return freeze({ parameter, closest: freeze(foot), distanceSquared: (x[0] - foot[0]) ** 2 + (x[1] - foot[1]) ** 2 });
}
export function lineIntersectionCoordinates({ a, b, c, d }) {
  const p = point(a, 'a'), q = point(b, 'b'), r = point(c, 'c'), s = point(d, 'd');
  if (same(p, q) || same(r, s)) throw new TypeError('lines must have distinct endpoints');
  const dx = q[0] - p[0], dy = q[1] - p[1], ex = s[0] - r[0], ey = s[1] - r[1], det = dx * ey - dy * ex;
  if (det === 0) return freeze({ relation: cross(p, q, r) === 0 ? 'COINCIDENT' : 'PARALLEL', intersection: null });
  const t = ((r[0] - p[0]) * ey - (r[1] - p[1]) * ex) / det;
  return freeze({ relation: 'INTERSECT', intersection: freeze([p[0] + dx * t, p[1] + dy * t]) });
}
export function latticePolygonInterior({ vertices }) {
  const { poly, area2 } = simplePolygon(vertices);
  const gcd = (x, y) => { while (y) [x, y] = [y, x % y]; return x; };
  let boundary = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    boundary += gcd(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }
  const numerator = Math.abs(area2) - boundary + 2;
  if (numerator < 0 || numerator % 2 !== 0) throw new RangeError('lattice polygon violates Pick theorem');
  return freeze({ interior: numerator / 2, boundary, twiceArea: Math.abs(area2) });
}
export function convexPolygonDiameter({ vertices }) {
  const poly = strictlyConvexCCW(vertices);
  let best = -1, pair = [0, 1];
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) {
    const d = squared(poly[i], poly[j]); if (d > best) { best = d; pair = [i, j]; }
  }
  return freeze({ diameterSquared: best, vertexIndices: freeze(pair) });
}
