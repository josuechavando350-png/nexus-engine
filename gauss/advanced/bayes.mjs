import { assertExactKeys } from '../core/common.mjs';
import { add, asString, complement, div, mul, probability } from './rational.mjs';

/** Exact Bernoulli Bayesian update with explicitly specified likelihoods. */
export function updateBinaryBayes(input) {
  assertExactKeys(input, ['prior', 'sensitivity', 'falsePositiveRate', 'evidence'], 'Bayes input');
  if (input.evidence !== 'POSITIVE' && input.evidence !== 'NEGATIVE') throw new TypeError('evidence must be POSITIVE or NEGATIVE');
  const prior = probability(input.prior, 'prior');
  const sensitivity = probability(input.sensitivity, 'sensitivity');
  const fpr = probability(input.falsePositiveRate, 'falsePositiveRate');
  const trueLikelihood = input.evidence === 'POSITIVE' ? sensitivity : complement(sensitivity);
  const falseLikelihood = input.evidence === 'POSITIVE' ? fpr : complement(fpr);
  const jointTrue = mul(prior, trueLikelihood);
  const jointFalse = mul(complement(prior), falseLikelihood);
  const evidenceProbability = add(jointTrue, jointFalse);
  if (evidenceProbability.n === 0n) throw new RangeError('conditioning on zero-probability evidence');
  return {
    posteriorTrue: asString(div(jointTrue, evidenceProbability)),
    posteriorFalse: asString(div(jointFalse, evidenceProbability)),
    evidenceProbability: asString(evidenceProbability),
    arithmetic: 'EXACT_RATIONAL',
    note: 'Posterior is conditional on the supplied prior and likelihoods; no empirical predictive accuracy is asserted.',
  };
}
