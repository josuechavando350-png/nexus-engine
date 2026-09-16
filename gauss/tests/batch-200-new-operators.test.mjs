import test from 'node:test';
import assert from 'node:assert/strict';
import * as signal from '../core/layers/signal-processing.mjs';
import * as stats from '../core/layers/descriptive-statistics.mjs';
import * as poly from '../core/layers/polynomial-algebra.mjs';
import * as arithmetic from '../core/layers/arithmetic-combinatorics.mjs';
import * as graph from '../core/layers/graph-structural.mjs';
import * as info from '../core/layers/discrete-information.mjs';
const close=(x,y,tol=1e-9)=>assert(Math.abs(x-y)<=tol*Math.max(1,Math.abs(x),Math.abs(y)),`${x} != ${y}`);
const sample={real:[1,2,3],imaginary:[0,0,0]};
test('12 signal algorithms: direct oracles, identities, and invalid inputs',()=>{
 assert.deepEqual(Object.keys(signal).length,12);
 const fft=signal.directDiscreteFourier(sample),inverse=signal.inverseDiscreteFourier(fft);
 sample.real.forEach((v,i)=>close(inverse.real[i],v));
 fft.imaginary.forEach((v,i)=>close(signal.goertzelFrequencyBin({samples:sample.real,bin:i}).imaginary,v));
 assert.deepEqual(signal.linearConvolution({left:[1,2],right:[3,4]}).samples,[3,10,8]);
 assert.deepEqual(signal.circularConvolution({left:[1,2],right:[3,4]}).samples,[11,10]);
 assert.deepEqual(signal.linearCrossCorrelation({left:[1,2],right:[3,4]}),{lags:[-1,0,1],values:[4,11,6]});
 assert.deepEqual(signal.sampleAutocovariance({samples:[1,2,3],maxLag:2}).covariance,[2/3,0,-1/3]);
 assert.deepEqual(signal.finiteImpulseResponse({samples:[1,2,3],taps:[1,-1]}).samples,[1,1,1]);
 assert.deepEqual(signal.firstOrderInfiniteImpulseResponse({samples:[1,1,1],feedforward:1,feedback:0.5,initial:0}).samples,[1,1.5,1.75]);
 const stft=signal.shortTimeFourier({samples:[1,2,3,4],window:2,hop:1});assert.equal(stft.frames.length,3);
 const spectrum=signal.powerPeriodogram({samples:[1,0,0,0],samplingRate:4});spectrum.power.forEach(v=>close(v,0.25));
 const haar=signal.orthonormalHaarTransform({samples:[1,1,1,1]});close(haar.coefficients[0],2);haar.coefficients.slice(1).forEach(x=>close(x,0));
 assert.throws(()=>signal.directDiscreteFourier({real:[1],imaginary:[]}),/length/);
 assert.throws(()=>signal.orthonormalHaarTransform({samples:[1,2,3]}),/power-of-two/);
 assert.throws(()=>signal.powerPeriodogram({samples:[1],samplingRate:0}),/positive/);
});
test('12 descriptive statistical algorithms: analytic and rank oracles',()=>{
 assert.equal(Object.keys(stats).length,12);
 const m=stats.weightedCentralMoments({samples:[1,3],weights:[1,1]});assert.equal(m.mean,2);assert.equal(m.variance,1);assert.equal(m.skewness,0);assert.equal(m.excessKurtosis,-2);
 assert.equal(stats.sampleCovariance({left:[1,2,3],right:[2,4,6]}).covariance,2);
 close(stats.pearsonCorrelation({left:[1,2,3],right:[2,4,6]}).correlation,1);
 close(stats.spearmanRankCorrelation({left:[3,1,2],right:[30,10,20]}).correlation,1);
 close(stats.kendallTauB({left:[1,2,3],right:[3,2,1]}).tau,-1);
 assert.deepEqual(stats.medianAbsoluteDeviation({samples:[1,2,9]}),{median:2,mad:1});
 assert.equal(stats.weightedEmpiricalQuantile({samples:[10,20,30],weights:[0,1,1],probability:0}).quantile,20);
 assert.deepEqual(stats.empiricalCdf({samples:[2,1,2],queries:[0,1,2,3]}).probabilities,[0,1/3,1,1]);
 assert.equal(stats.twoSampleKolmogorovSmirnov({left:[1,1],right:[2,2]}).statistic,1);
 assert.equal(stats.mannWhitneyRankSum({left:[1,2],right:[3,4]}).uLeft,0);
 close(stats.nonnegativeGiniCoefficient({samples:[1,1,1]}).gini,0);
 assert.equal(stats.pearsonChiSquareIndependence({counts:[[10,10],[10,10]]}).chiSquare,0);
 assert.throws(()=>stats.pearsonCorrelation({left:[1,1],right:[1,2]}),/constant/);
 assert.throws(()=>stats.nonnegativeGiniCoefficient({samples:[0,0]}),/all-zero/);
});
test('12 polynomial operators: independent algebra identities',()=>{
 assert.equal(Object.keys(poly).length,12);
 assert.equal(poly.hornerPolynomialEvaluation({coefficients:[1,2,3],at:2}).value,17);
 assert.deepEqual(poly.analyticPolynomialDerivative({coefficients:[1,2,3]}).coefficients,[2,6]);
 assert.equal(poly.definitePolynomialIntegral({coefficients:[0,1],lower:0,upper:2}).integral,2);
 assert.deepEqual(poly.polynomialConvolutionProduct({left:[1,1],right:[1,-1]}).coefficients,[1,0,-1]);
 const divided=poly.realPolynomialLongDivision({dividend:[-1,0,1],divisor:[-1,1]});assert.deepEqual(divided.quotient,[1,1]);assert.deepEqual(divided.remainder,[0]);
 close(poly.barycentricLagrangeInterpolation({nodes:[0,1,2],values:[1,2,5],at:3}).value,10);
 assert.deepEqual(poly.newtonDividedDifferenceTable({nodes:[0,1,2],values:[1,2,5]}).newtonCoefficients,[1,1,1]);
 assert.deepEqual(poly.realQuadraticRootClassification({a:1,b:0,c:-4}).roots,[-2,2]);
 assert.deepEqual(poly.polynomialComposition({outer:[1,1,1],inner:[0,2]}).coefficients,[1,2,4]);
 assert.deepEqual(poly.polynomialArgumentTranslation({coefficients:[1,2,3],shift:2}).coefficients,[17,14,3]);
 assert.deepEqual(poly.powerToBernsteinCoefficients({coefficients:[0,0,1]}).bernsteinCoefficients,[0,0,1]);
 assert.deepEqual(poly.forwardFiniteDifferenceTable({values:[0,1,4,9]}).leadingDifferences,[0,1,2,0]);
 assert.throws(()=>poly.realPolynomialLongDivision({dividend:[1],divisor:[0]}),/zero divisor/);
 assert.throws(()=>poly.barycentricLagrangeInterpolation({nodes:[1,1],values:[2,3],at:2}),/distinct/);
});
test('12 arithmetic algorithms: integer mathematical identities and invalid domains',()=>{
 assert.equal(Object.keys(arithmetic).length,12);
 assert.equal(arithmetic.mobiusFunction({n:30}).mu,-1);assert.equal(arithmetic.mobiusFunction({n:12}).mu,0);
 assert.equal(arithmetic.exactDivisorSum({n:12}).sum,'28');assert.equal(arithmetic.exactDivisorCount({n:12}).count,6);
 assert.equal(arithmetic.multiplicativeOrder({base:2,modulus:7}).order,3);
 assert.equal(arithmetic.boundedPrimeDiscreteLog({base:2,target:4,prime:7}).exponent,2);
 assert.equal(arithmetic.jacobiSymbol({numerator:2,denominator:7}).symbol,1);
 assert.deepEqual(arithmetic.modularSquareRootsPrime({value:4,prime:7}).roots,[2,5]);
 assert.deepEqual(arithmetic.solveLinearCongruence({a:4,b:2,modulus:6}).solutions,[2,5]);
 const witness=arithmetic.linearDiophantineWitness({a:6,b:15,c:3});assert.equal(6n*BigInt(witness.x)+15n*BigInt(witness.y),3n);
 assert.deepEqual(arithmetic.rationalContinuedFraction({numerator:13,denominator:5}).quotients,[2,1,1,2]);
 assert.equal(arithmetic.fareySequence({order:5}).fractions.length,11);
 assert.deepEqual(arithmetic.primitivePythagoreanTriples({maxHypotenuse:5}).triples,[[3,4,5]]);
 assert.throws(()=>arithmetic.boundedPrimeDiscreteLog({base:2,target:3,prime:9}),/prime/);
 assert.throws(()=>arithmetic.jacobiSymbol({numerator:1,denominator:4}),/odd/);
});
test('12 structural graph algorithms: complete small-graph oracles and witnesses',()=>{
 assert.equal(Object.keys(graph).length,12);
 const dag={vertexCount:3,edges:[{from:0,to:1},{from:1,to:2},{from:0,to:2}]};
 assert.deepEqual(graph.directedTransitiveClosure(dag).reachable,[[true,true,true],[false,true,true],[false,false,true]]);
 assert.deepEqual(graph.dagTransitiveReduction(dag).edges,[{from:0,to:1},{from:1,to:2}]);
 assert.deepEqual(graph.longestWeightedDagPath({vertexCount:3,edges:[{from:0,to:1,weight:5},{from:1,to:2,weight:-1},{from:0,to:2,weight:2}],source:0,target:2}),{reachable:true,weight:4,path:[0,1,2]});
 const cycle={vertexCount:3,edges:[{from:0,to:1},{from:1,to:2},{from:2,to:0}]};
 assert.deepEqual(graph.boundedDirectedSimpleCycles(cycle).cycles,[[0,1,2]]);
 const feedback=graph.exactDirectedFeedbackVertexSet(cycle);assert.equal(feedback.size,1);
 const path={vertexCount:3,edges:[{from:0,to:1},{from:1,to:2}]};
 assert.equal(graph.undirectedGlobalEdgeConnectivity(path).cutSize,1);
 assert.deepEqual(graph.graphEccentricities(path).eccentricities,[2,1,2]);
 assert.deepEqual(graph.unweightedGraphCenter(path),{radius:1,centers:[1]});
 assert.deepEqual(graph.independencePolynomial(path).coefficients,[1,3,1,0]);
 assert.equal(graph.undirectedTriangleCount({vertexCount:3,edges:[{from:0,to:1},{from:1,to:2},{from:0,to:2}]}).triangles,1);
 assert.equal(graph.exactRootedOutArborescenceCount({vertexCount:3,edges:dag.edges,root:0}).arborescences,'2');
 assert.deepEqual(graph.undirectedCoreDecomposition(path).coreNumbers,[1,1,1]);
 assert.throws(()=>graph.dagTransitiveReduction(cycle),/DAG/);
 assert.throws(()=>graph.unweightedGraphCenter({vertexCount:2,edges:[]}),/connected/);
});
test('12 information algorithms: independent entropy identities and invalid distributions',()=>{
 assert.equal(Object.keys(info).length,12);
 close(info.kullbackLeiblerDivergence({p:[1,0],q:[0.5,0.5]}).divergence,Math.log(2));
 assert.equal(info.kullbackLeiblerDivergence({p:[1,0],q:[0,1]}).kind,'POSITIVE_INFINITY');
 const js=info.jensenShannonDivergence({p:[1,0],q:[0,1]});close(js.divergence,Math.log(2));
 assert.equal(info.totalVariationDistance({p:[1,0],q:[0,1]}).distance,1);
 close(info.hellingerDistance({p:[1,0],q:[0,1]}).distance,1);
 assert.equal(info.bhattacharyyaCoefficient({p:[1,0],q:[0,1]}).coefficient,0);
 assert.equal(info.chernoffInformation({p:[1,0],q:[0,1]}).kind,'POSITIVE_INFINITY');
 assert.equal(info.discreteWassersteinOne({positions:[0,2],p:[1,0],q:[0,1]}).distance,2);
 assert.deepEqual(info.discreteBayesianPosterior({prior:[0.5,0.5],likelihood:[1,0]}).posterior,[1,0]);
 close(info.stationaryMarkovEntropyRate({transition:[[0.5,0.5],[0.5,0.5]],stationary:[0.5,0.5]}).entropyRate,Math.log(2));
 close(info.conditionalMutualInformation({joint:[[[0.5]],[[0.5]]]}).conditionalMutualInformation,0);
 close(info.discreteMemorylessChannelCapacity({transition:[[1,0],[0,1]]}).capacity,Math.log(2));
 close(info.conditionalShannonEntropy({joint:[[0.25,0.25],[0.25,0.25]]}).conditionalEntropy,Math.log(2));
 assert.throws(()=>info.kullbackLeiblerDivergence({p:[0.2,0.2],q:[0.5,0.5]}),/sum to one/);
 assert.throws(()=>info.discreteBayesianPosterior({prior:[0.5,0.5],likelihood:[0,0]}),/zero probability/);
});

test('quadratic classifications survive tiny scales, exact signs and near-multiple roots',()=>{
 const classify=poly.realQuadraticRootClassification;
 for(const scale of [1e-160,1e-200,1e-300,Number.MIN_VALUE]){
  const positive=classify({a:scale,b:0,c:-scale});
  assert.equal(positive.realRootCount,2);if(scale!==1e-160)assert.equal(positive.discriminant,null);
  close(positive.roots[0],-1);close(positive.roots[1],1);
  const negative=classify({a:scale,b:0,c:scale});
  assert.equal(negative.realRootCount,0);if(scale!==1e-160)assert.equal(negative.discriminant,null);
  const repeated=classify({a:scale,b:2*scale,c:scale});
  assert.equal(repeated.realRootCount,1);close(repeated.roots[0],-1);
 }
 const closePair=classify({a:1,b:2,c:1-Number.EPSILON});
 assert.equal(closePair.realRootCount,2);assert(closePair.roots[0]<-1&&closePair.roots[1]>-1);
 const tinyPair=classify({a:1e-200,b:2e-200,c:1e-200*(1-1e-12)});
 assert.equal(tinyPair.realRootCount,2);
 for(const root of tinyPair.roots)assert(Math.abs(root*root+2*root+1-1e-12)<1e-10);
 const subnormal=classify({a:10000,b:1,c:Number.MIN_VALUE});
 assert.equal(subnormal.realRootCount,2);close(subnormal.roots[0],-1e-4);assert.equal(subnormal.roots[1],-Number.MIN_VALUE);
 assert.deepEqual(classify({a:1,b:0,c:-4}),{discriminant:16,roots:[-2,2],realRootCount:2});
 assert.deepEqual(classify({a:1,b:2,c:1}),{discriminant:0,roots:[-1],realRootCount:1});
 for(const b of [10000,-10000])for(const c of [Number.MIN_VALUE,-Number.MIN_VALUE]){
  assert.throws(()=>classify({a:1,b,c}),/numerically unresolvable/,
   'a subnormal nonzero constant must never manufacture an exact zero root');
 }
 assert.deepEqual(classify({a:1,b:1,c:0}),{discriminant:1,roots:[-1,0],realRootCount:2});
 for(const input of [
  {a:2,b:-7.888609052210118e-31,c:1.5e-323},
  {a:1,b:-1e-160,c:-Number.MIN_VALUE},
  {a:-3,b:7.888609052210118e-30,c:-1e-323},
  {a:-3,b:7.888609052210118e-31,c:1e-323}
 ])assert.throws(()=>classify(input),/residual precision/,
 'subnormal cancellation must fail closed when roots cannot be represented accurately');
 assert.throws(()=>classify({a:1e-300,b:1,c:1}),/bounded numerical result|numerical|precision/);
});
