// The immutable audited foundation is retained byte-for-byte in registry-foundation.mjs.
// Additional scientific operators are appended here without altering its implementation.
import { deepFreeze } from './common.mjs';
import {
  GAUSS_DOMAINS,
  GAUSS_IMPLEMENTED_LAYERS as foundationLayers,
} from './registry-foundation.mjs';
import {
  extendedEuclidean, modularInverse, pairwiseCoprimeChineseRemainder,
  modularExponentiation, trialDivisionFactorization, eulerTotient,
  deterministicSafeIntegerPrimality, boundedPrimeSieve, exactIntegerSquareRoot,
  exactBinomialCoefficient, exactFibonacciFastDoubling, exactIntegerPartitionCount,
} from './layers/number-theory.mjs';
import {
  linearStateSpaceTrajectory, finiteControllabilityGramian, finiteObservabilityGramian,
  exactControllabilityRank, exactObservabilityRank, scalarKalmanFilter,
  scalarRauchTungStriebelSmoother, boundedPidController, finiteHorizonDiagonalCostLqr,
  stableScalarLyapunovCertificate, scalarMinimumEnergyReachability, scalarIntervalReachability,
} from './layers/control-systems.mjs';
import {
  signedOrientation, segmentIntersectionClass, convexHullMonotone, polygonSignedArea,
  polygonCentroid, polygonPerimeter, pointInSimplePolygon, closestPairSquared,
  farthestPairSquared, pointSegmentProjection, lineIntersectionCoordinates,
  latticePolygonInterior, convexPolygonDiameter,
} from './layers/computational-geometry.mjs';

export { GAUSS_DOMAINS };

const additions = [
  ['GAUSS.MATH.EXTENDED_EUCLID.010', 'MATHEMATICS', 'Bounded exact greatest common divisor with Bezout identity certificate', extendedEuclidean],
  ['GAUSS.MATH.MODULAR_INVERSE.011', 'MATHEMATICS', 'Exact modular inverse over a coprime integer modulus', modularInverse],
  ['GAUSS.MATH.CRT_COPRIME.012', 'MATHEMATICS', 'Exact bounded Chinese remainder solution for pairwise coprime moduli', pairwiseCoprimeChineseRemainder],
  ['GAUSS.MATH.MODULAR_EXPONENT.013', 'MATHEMATICS', 'Exact binary modular exponentiation using BigInt intermediates', modularExponentiation],
  ['GAUSS.MATH.PRIME_FACTORIZATION.014', 'MATHEMATICS', 'Exact bounded prime factorization with multiplicities', trialDivisionFactorization],
  ['GAUSS.MATH.EULER_TOTIENT.015', 'MATHEMATICS', 'Euler totient by distinct prime factors of a bounded integer', eulerTotient],
  ['GAUSS.MATH.PRIMALITY_SAFE_INT.016', 'MATHEMATICS', 'Deterministic Miller-Rabin primality for IEEE-754 safe integers', deterministicSafeIntegerPrimality],
  ['GAUSS.MATH.PRIME_SIEVE.017', 'MATHEMATICS', 'Bounded sieve of Eratosthenes yielding the full prime list', boundedPrimeSieve],
  ['GAUSS.MATH.INTEGER_SQRT.018', 'MATHEMATICS', 'Exact floor square root with remainder witness for safe integers', exactIntegerSquareRoot],
  ['GAUSS.MATH.BINOMIAL_EXACT.019', 'MATHEMATICS', 'Exact binomial coefficient with a decimal BigInt result', exactBinomialCoefficient],
  ['GAUSS.MATH.FIBONACCI_DOUBLING.020', 'MATHEMATICS', 'Exact bounded Fibonacci number by fast doubling', exactFibonacciFastDoubling],
  ['GAUSS.MATH.INTEGER_PARTITIONS.021', 'MATHEMATICS', 'Exact bounded unrestricted integer partition count', exactIntegerPartitionCount],
  ['GAUSS.CONTROL.STATE_SPACE_TRAJECTORY.003', 'CONTROL_DYNAMICS', 'Bounded discrete-time multivariate linear state-space trajectory', linearStateSpaceTrajectory],
  ['GAUSS.CONTROL.CONTROLLABILITY_GRAMIAN.004', 'CONTROL_DYNAMICS', 'Finite-horizon discrete controllability Gramian', finiteControllabilityGramian],
  ['GAUSS.CONTROL.OBSERVABILITY_GRAMIAN.005', 'CONTROL_DYNAMICS', 'Finite-horizon discrete observability Gramian', finiteObservabilityGramian],
  ['GAUSS.CONTROL.EXACT_CONTROLLABILITY_RANK.006', 'CONTROL_DYNAMICS', 'Exact integer controllability matrix rank with dimension bounds', exactControllabilityRank],
  ['GAUSS.CONTROL.EXACT_OBSERVABILITY_RANK.007', 'CONTROL_DYNAMICS', 'Exact integer observability matrix rank with dimension bounds', exactObservabilityRank],
  ['GAUSS.CONTROL.SCALAR_KALMAN_FILTER.008', 'CONTROL_DYNAMICS', 'Scalar Gaussian Kalman state filter and log-likelihood', scalarKalmanFilter],
  ['GAUSS.CONTROL.SCALAR_RTS_SMOOTHER.009', 'CONTROL_DYNAMICS', 'Scalar Rauch-Tung-Striebel fixed-interval state smoother', scalarRauchTungStriebelSmoother],
  ['GAUSS.CONTROL.BOUNDED_PID.010', 'CONTROL_DYNAMICS', 'Bounded discrete PID command sequence with integral anti-windup', boundedPidController],
  ['GAUSS.CONTROL.DIAGONAL_LQR.011', 'CONTROL_DYNAMICS', 'Finite-horizon multivariate Riccati feedback with diagonal costs', finiteHorizonDiagonalCostLqr],
  ['GAUSS.CONTROL.SCALAR_LYAPUNOV.012', 'CONTROL_DYNAMICS', 'Stable scalar discrete Lyapunov covariance and residual certificate', stableScalarLyapunovCertificate],
  ['GAUSS.CONTROL.MIN_ENERGY_REACHABILITY.013', 'CONTROL_DYNAMICS', 'Minimum-energy scalar endpoint reachability with control witness', scalarMinimumEnergyReachability],
  ['GAUSS.CONTROL.INTERVAL_REACHABILITY.014', 'CONTROL_DYNAMICS', 'Exact scalar interval reachable-set propagation under bounded controls', scalarIntervalReachability],
  ['GAUSS.MATH.ORIENTATION_2D.022', 'MATHEMATICS', 'Exact bounded integer signed orientation predicate', signedOrientation],
  ['GAUSS.MATH.SEGMENT_INTERSECTION.023', 'MATHEMATICS', 'Exact bounded segment intersection classification including overlap', segmentIntersectionClass],
  ['GAUSS.MATH.CONVEX_HULL_2D.024', 'MATHEMATICS', 'Monotone-chain convex hull with collinear interior removal', convexHullMonotone],
  ['GAUSS.MATH.POLYGON_SIGNED_AREA.025', 'MATHEMATICS', 'Signed simple lattice polygon area by shoelace sum', polygonSignedArea],
  ['GAUSS.MATH.POLYGON_CENTROID.026', 'MATHEMATICS', 'Area-weighted centroid for bounded simple integer-coordinate polygons', polygonCentroid],
  ['GAUSS.MATH.POLYGON_PERIMETER.027', 'MATHEMATICS', 'Euclidean perimeter of a bounded simple polygon', polygonPerimeter],
  ['GAUSS.MATH.POINT_POLYGON_LOCATION.028', 'MATHEMATICS', 'Exact integer inside, boundary or outside point-in-simple-polygon test', pointInSimplePolygon],
  ['GAUSS.MATH.CLOSEST_PAIR_2D.029', 'MATHEMATICS', 'Exact bounded minimum squared point-pair distance with witness', closestPairSquared],
  ['GAUSS.MATH.FARTHEST_PAIR_2D.030', 'MATHEMATICS', 'Exact bounded maximum squared point-pair distance with witness', farthestPairSquared],
  ['GAUSS.MATH.POINT_SEGMENT_PROJECTION.031', 'MATHEMATICS', 'Clamped Euclidean point-to-segment projection and squared distance', pointSegmentProjection],
  ['GAUSS.MATH.LINE_INTERSECTION_2D.032', 'MATHEMATICS', 'Parallel, coincident and proper infinite-line intersection coordinates', lineIntersectionCoordinates],
  ['GAUSS.MATH.PICK_LATTICE_INTERIOR.033', 'MATHEMATICS', 'Exact interior lattice-point count via Pick theorem for simple lattice polygons', latticePolygonInterior],
  ['GAUSS.MATH.CONVEX_POLYGON_DIAMETER.034', 'MATHEMATICS', 'Exact bounded convex-polygon diameter with extreme-vertex witness', convexPolygonDiameter],
];

const domainIds = new Set(GAUSS_DOMAINS.map(domain => domain.id));
const ids = new Set(foundationLayers.map(layer => layer.id));
export const GAUSS_IMPLEMENTED_LAYERS = deepFreeze([
  ...foundationLayers,
  ...additions.map(([id, domain, description, execute]) => {
    if (ids.has(id)) throw new Error(`duplicate GAUSS layer id:${id}`);
    if (!domainIds.has(domain)) throw new Error(`unknown GAUSS domain:${domain}`);
    if (typeof execute !== 'function') throw new Error(`GAUSS layer is not executable:${id}`);
    ids.add(id);
    return { id, domain, description, execute };
  }),
]);
const byId = new Map(GAUSS_IMPLEMENTED_LAYERS.map(layer => [layer.id, layer]));
export function getGaussLayer(layerId) { return byId.get(layerId) ?? null; }
export function gaussRegistrySummary() {
  const implementedByDomain = Object.fromEntries(GAUSS_DOMAINS.map(domain => [domain.id, 0]));
  for (const layer of GAUSS_IMPLEMENTED_LAYERS) implementedByDomain[layer.domain] += 1;
  return deepFreeze({
    targetLayerCount: GAUSS_DOMAINS.reduce((sum, domain) => sum + domain.targetLayers, 0),
    implementedLayerCount: GAUSS_IMPLEMENTED_LAYERS.length,
    implementedByDomain,
    domains: GAUSS_DOMAINS,
  });
}
