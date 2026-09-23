/** GAUSS -> Némesis: namespaced, fail-closed access to the original 100 IDs. */
import {existsSync} from 'node:fs';
import {runGaussNemesis89} from './native-fhe.mjs';
import {runGaussNemesis89Sealed} from './fhe-89-sealed.mjs';
import {runGaussNemesis89Backup} from './fhe-89-backup.mjs';
import {runGaussNemesis81Signature} from './native-sqisign-81.mjs';
import {runGaussNemesis81Sealed} from './sqisign-81-sealed.mjs';
import {runGaussNemesis81KeyRotation} from './sqisign-81-key-rotation.mjs';
import {runGaussNemesis95Pinned} from './groth16-95-pinned.mjs';
import {filterGaussNemesis96} from './kalman-96.mjs';
import {multifractalDFA} from './dfa-78.mjs';
import {whiteNoiseDFAReference} from './dfa-78-reference.mjs';
import {verifyTwoIsogenyDualIdentity} from './isogeny-81-foundation.mjs';
import {evaluateCyclicVelu} from './isogeny-81-cyclic.mjs';
import {evaluatePublicVeluChain} from './isogeny-81-chain.mjs';
import {verifyClaimedPublicVeluChain} from './isogeny-81-claim.mjs';

const moduleUrl = new URL('./engine/src/index.mjs', import.meta.url);
const incomplete = Object.freeze([81, 89, 95]);

function normalizeId(id) {
  const n = typeof id === 'number' ? id : typeof id === 'string' && /^(?:[1-9]|[1-9][0-9]|100|0[1-9])$/.test(id) ? Number(id) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new RangeError('Némesis ID must be an integer between 1 and 100');
  return String(n).padStart(2, '0');
}

async function loadEngine() {
  if (!existsSync(moduleUrl)) throw new Error('NEMESIS_SOURCE_MISSING: gauss/nemesis/engine/src/index.mjs must exist; no stub fallback');
  const engine = await import(moduleUrl.href);
  if (typeof engine.verifyFiniteSystem !== 'function' || typeof engine.runMotor !== 'function' ||
      !engine.MOTOR_REGISTRY || Object.keys(engine.MOTOR_REGISTRY).length !== 99 ||
      Array.from({length:99}, (_, i) => String(i + 2).padStart(2, '0')).some(id => typeof engine.MOTOR_REGISTRY[id] !== 'function')) {
    throw new Error('NEMESIS_REGISTRY_INCOMPLETE: expected #01 plus exact #02..#100');
  }
  return engine;
}

export async function runGaussNemesis(id, input) {
  const normalized = normalizeId(id);
  if (normalized === '89' && (input?.action === 'native-add-u8' || input?.action === 'native-circuit'))
    return runGaussNemesis89(input);
  if (normalized === '89' && ['sealed-keygen', 'sealed-encrypt', 'sealed-decrypt', 'sealed-rekey'].includes(input?.action))
    return runGaussNemesis89Sealed(input);
  if (normalized === '89' && input?.action === 'sealed-backup')
    return runGaussNemesis89Backup(input);
  if (normalized === '81' && ['sqisign-keygen-sealed', 'sqisign-sign-sealed', 'sqisign-rekey-sealed'].includes(input?.action))
    return runGaussNemesis81Sealed(input);
  if (normalized === '81' && ['sqisign-rotate-keypair-sealed', 'sqisign-verify-key-rotation'].includes(input?.action))
    return runGaussNemesis81KeyRotation(input);
  if (normalized === '81' && ['sqisign-keygen', 'sqisign-sign', 'sqisign-verify'].includes(input?.action))
    return runGaussNemesis81Signature(input);
  if (normalized === '95' && ['prove-pinned', 'verify-pinned'].includes(input?.action))
    return runGaussNemesis95Pinned(input);
  const engine = await loadEngine();
  if (normalized === '78' && ['multifractal', 'white-noise-reference'].includes(input?.action)) {
    if (Object.keys(input).sort().join(',') !== 'action,payload') throw new TypeError('motor 78: expected action and payload');
    return input.action === 'multifractal' ? multifractalDFA(input.payload) : whiteNoiseDFAReference(input.payload);
  }
  if (normalized === '81' && ['verify-dual', 'evaluate-cyclic', 'evaluate-public-chain', 'verify-public-claim'].includes(input?.action)) {
    if (Object.keys(input).sort().join(',') !== 'action,payload') throw new TypeError('motor 81: expected action and payload');
    if (input.action === 'verify-dual') return verifyTwoIsogenyDualIdentity(input.payload);
    if (input.action === 'evaluate-cyclic') return evaluateCyclicVelu(input.payload);
    if (input.action === 'evaluate-public-chain') return evaluatePublicVeluChain(input.payload);
    return verifyClaimedPublicVeluChain(input.payload);
  }
  if (normalized === '96' && input?.action === 'filter') {
    if (Object.keys(input).sort().join(',') !== 'action,payload') throw new TypeError('motor action: expected action and payload');
    return filterGaussNemesis96(input.payload);
  }
  return normalized === '01' ? engine.verifyFiniteSystem(input) : engine.runMotor(normalized, input);
}

export function gaussNemesisStatus() {
  return Object.freeze({namespace:'gauss:nemesis', sourcePresent:existsSync(moduleUrl), declaredEngineIds:100,
    nativeFheEntryPresent:true, nativeOrOriginalScopeIncomplete:incomplete, certified:false,
    caveat:'An executable registry and 100 example matches do not certify the original scope of every engine.'});
}
