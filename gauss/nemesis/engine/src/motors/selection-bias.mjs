import { object, rational, mul, add, sub, div, cmp, fmt, ONE, ZERO } from './shared.mjs';

/** Conditional-on-selection Bayes calculation; not a diagnosis of a person's cognition. */
export function analyzeSelectionBias(input) {
  object(input, 'selection model', ['priorTrue','positiveIfTrue','positiveIfFalse','selectedIfTruePositive','selectedIfTrueNegative','selectedIfFalsePositive','selectedIfFalseNegative']);
  const prior = rational(input.priorTrue, 'priorTrue', {probability:true});
  const p = rational(input.positiveIfTrue, 'positiveIfTrue', {probability:true});
  const q = rational(input.positiveIfFalse, 'positiveIfFalse', {probability:true});
  const tp = rational(input.selectedIfTruePositive, 'selectedIfTruePositive', {probability:true});
  const tn = rational(input.selectedIfTrueNegative, 'selectedIfTrueNegative', {probability:true});
  const fp = rational(input.selectedIfFalsePositive, 'selectedIfFalsePositive', {probability:true});
  const fn = rational(input.selectedIfFalseNegative, 'selectedIfFalseNegative', {probability:true});
  if (cmp(prior,ZERO)===0 || cmp(prior,ONE)===0) throw new TypeError('priorTrue must be strictly between 0 and 1');
  const selectionTrue=add(mul(p,tp),mul(sub(ONE,p),tn));
  const selectionFalse=add(mul(q,fp),mul(sub(ONE,q),fn));
  if (cmp(selectionTrue,ZERO)===0 || cmp(selectionFalse,ZERO)===0) throw new TypeError('selection probability must be positive for both hypotheses');
  const selectedPrior=div(mul(prior,selectionTrue),add(mul(prior,selectionTrue),mul(sub(ONE,prior),selectionFalse)));
  const selectedPositiveTrue=div(mul(p,tp),selectionTrue);
  const selectedPositiveFalse=div(mul(q,fp),selectionFalse);
  const update=(base,lt,lf) => {
    const a=mul(base,lt), b=mul(sub(ONE,base),lf), d=add(a,b);
    return cmp(d,ZERO)===0 ? null : fmt(div(a,d));
  };
  return {
    engine:'NEMESIS_SELECTION_CONDITIONING_V1', domain:'BINARY_KNOWN_SELECTION_MODEL',
    selectedProbabilityIfTrue:fmt(selectionTrue), selectedProbabilityIfFalse:fmt(selectionFalse),
    priorTrueAmongSelected:fmt(selectedPrior),
    positiveProbabilityAmongSelectedIfTrue:fmt(selectedPositiveTrue),
    positiveProbabilityAmongSelectedIfFalse:fmt(selectedPositiveFalse),
    populationPosteriorAfterPositive: update(prior,p,q),
    populationPosteriorAfterNegative: update(prior,sub(ONE,p),sub(ONE,q)),
    naivePosteriorAfterPositive: update(selectedPrior,p,q),
    selectionAdjustedPosteriorAfterPositive: update(selectedPrior,selectedPositiveTrue,selectedPositiveFalse),
    naivePosteriorAfterNegative: update(selectedPrior,sub(ONE,p),sub(ONE,q)),
    selectionAdjustedPosteriorAfterNegative: update(selectedPrior,sub(ONE,selectedPositiveTrue),sub(ONE,selectedPositiveFalse)),
    note:'PriorTrue is the population prior; selected prior is calculated by Bayes, then observation likelihoods are conditioned on selection. Known selection probabilities are assumptions, not inferred human motives.'
  };
}
