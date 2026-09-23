/**
 * Re-evaluate a claimed PUBLIC small-field isogeny walk from first principles.
 * The expected result is untrusted; no signature or authenticity is inferred.
 * This is variable-time finite arithmetic and MUST NOT be used with secrets.
 */
import {evaluatePublicVeluChain} from './isogeny-81-chain.mjs';

function record(x, label, keys) {
  if (x === null || typeof x !== 'object' || Array.isArray(x) ||
      Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x,k)))
    throw new TypeError(`${label}: expected exactly ${keys.join(',')}`);
}
function equalPoint(P,Q) {
  return P === null ? Q === null : Q !== null && P.x === Q.x && P.y === Q.y;
}
/**
 * Input: {statement:{p,a,b,steps,points},expected:{target:{p,a,b},degreeProduct,images}}.
 * An accepted claim proves ONLY that this finite public calculation replays.
 * It does NOT prove signer identity, possession of any secret, or PQ security.
 */
export function verifyClaimedPublicVeluChain(input) {
  record(input,'claim',['statement','expected']);
  const {statement,expected}=input;
  record(expected,'expected',['target','degreeProduct','images']);
  record(expected.target,'expected.target',['p','a','b']);
  if (typeof expected.degreeProduct !== 'string' || !/^[1-9][0-9]*$/.test(expected.degreeProduct))
    throw new TypeError('expected.degreeProduct must be a canonical positive decimal string');
  if (!Array.isArray(expected.images))
    throw new TypeError('expected.images must be an array');
  const actual=evaluatePublicVeluChain(statement);
  if (expected.degreeProduct !== actual.degreeProduct ||
      expected.target.p !== actual.target.p ||
      expected.target.a !== actual.target.a || expected.target.b !== actual.target.b ||
      expected.images.length !== actual.images.length)
    throw new Error('PUBLIC_ISOGENY_CLAIM_MISMATCH');
  for (let i=0;i<expected.images.length;i++) {
    const point=expected.images[i];
    if (point !== null) record(point,`expected.images[${i}]`,['x','y']);
    if (!equalPoint(point,actual.images[i]))
      throw new Error(`PUBLIC_ISOGENY_CLAIM_MISMATCH_AT_${i}`);
  }
  return {
    domain:'VERIFIED_PUBLIC_VELU_CHAIN_SMALL_FIELD_NOT_SIGNATURE',
    verified:true,
    degreeProduct:actual.degreeProduct,
    pointsChecked:actual.images.length,
    warning:'A recomputed public isogeny claim is NOT an authenticated signature, secret-key proof or post-quantum security claim.'
  };
}
