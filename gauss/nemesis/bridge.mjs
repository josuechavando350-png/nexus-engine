/** GAUSS -> Némesis: namespaced, fail-closed access to the original 100 IDs. */
import {existsSync} from 'node:fs';

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

/** This is a call bridge, not a production certification for the conceptual scope. */
export async function runGaussNemesis(id, input) {
  const normalized = normalizeId(id);
  const engine = await loadEngine();
  return normalized === '01' ? engine.verifyFiniteSystem(input) : engine.runMotor(normalized, input);
}

export function gaussNemesisStatus() {
  return Object.freeze({namespace:'gauss:nemesis', sourcePresent:existsSync(moduleUrl), declaredEngineIds:100,
    nativeOrOriginalScopeIncomplete:incomplete, certified:false,
    caveat:'An executable registry and 100 example matches do not certify the original scope of every engine.'});
}
