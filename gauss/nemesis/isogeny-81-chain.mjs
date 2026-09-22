/** Public mathematical composition of verified small-field Vélu isogenies. */
import {evaluateCyclicVelu} from './isogeny-81-cyclic.mjs';

/**
 * Sequentially evaluate a PUBLIC isogeny walk, checking the claimed generator
 * on the actual previous codomain at each step. No secret-key/signature use.
 * Input: {p,a,b,steps:[{degree,generator}],points:[...]}.
 */
export function evaluatePublicVeluChain(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['p','a','b','steps','points'].includes(k)) ||
      ['p','a','b','steps','points'].some(k => !Object.hasOwn(input,k)))
    throw new TypeError('expected {p,a,b,steps,points}');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 16)
    throw new TypeError('steps must have between 1 and 16 entries');
  let {p,a,b}=input, points=input.points;
  const trace=[];
  let degreeProduct=1n;
  for (let i=0;i<input.steps.length;i++) {
    const step=input.steps[i];
    if (step===null || typeof step!=='object' || Array.isArray(step) ||
        Object.keys(step).sort().join(',')!=='degree,generator')
      throw new TypeError(`steps[${i}]: expected {degree,generator}`);
    const result=evaluateCyclicVelu({p,a,b,degree:step.degree,generator:step.generator,points});
    trace.push({degree:result.degree,source:result.source,target:result.target,kernel:result.kernel});
    degreeProduct*=BigInt(result.degree);
    ({p,a,b}=result.target);
    points=result.images;
  }
  return {
    domain:'VELU_PUBLIC_CHAIN_SMALL_FIELD_NOT_SIGNATURE',
    source:trace[0].source,
    target:trace.at(-1).target,
    degreeProduct:degreeProduct.toString(),
    trace,
    images:points,
    warning:'Public small-field isogeny walk only; NOT a signature, key derivation, private walk or post-quantum security.'
  };
}
