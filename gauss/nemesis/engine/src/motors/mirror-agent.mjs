import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { object, array, id, integer, unique } from './shared.mjs';

function normalize(input) {
  object(input, 'mirrored agents', ['states', 'initial', 'transitions', 'schedule', 'forbiddenStates', 'fault'], ['states', 'initial', 'transitions', 'schedule']);
  const states = unique(array(input.states, 'states', 1, 64).map(x => id(x, 'state')), 'states');
  const stateSet = new Set(states);
  const initial = id(input.initial, 'initial');
  if (!stateSet.has(initial)) throw new TypeError('unknown initial state');
  const transitions = array(input.transitions, 'transitions', 0, 4096).map((t, i) => {
    object(t, `transition[${i}]`, ['from', 'action', 'to']);
    if (!stateSet.has(t.from) || !stateSet.has(t.to)) throw new TypeError('unknown transition state');
    return { from: t.from, action: id(t.action, 'action'), to: t.to };
  });
  unique(transitions.map(t => `${t.from}\0${t.action}`), 'state-action pairs');
  const schedule = array(input.schedule, 'schedule', 0, 1000).map((a, i) => {
    object(a, `schedule[${i}]`, ['time', 'action']);
    const time = integer(a.time, 'logical time', 0, 1_000_000_000);
    if (i > 0 && time < input.schedule[i - 1].time) throw new TypeError('logical time must be monotone');
    return { time, action: id(a.action, 'scheduled action') };
  });
  const forbiddenStates = unique(array(input.forbiddenStates ?? [], 'forbiddenStates', 0, states.length).map(s => id(s, 'forbidden state')), 'forbiddenStates');
  if (forbiddenStates.some(s => !stateSet.has(s))) throw new TypeError('unknown forbidden state');
  let fault = null;
  if (input.fault !== undefined) {
    object(input.fault, 'fault', ['replica', 'step', 'overrideState']);
    if (input.fault.replica !== 2) throw new TypeError('only replica 2 fault injection is supported');
    fault = { replica: 2, step: integer(input.fault.step, 'fault.step', 0, schedule.length - 1), overrideState: id(input.fault.overrideState, 'overrideState') };
    if (!stateSet.has(fault.overrideState)) throw new TypeError('fault references unknown state');
  }
  return { states, initial, transitions, schedule, forbiddenStates, fault };
}
export function executeMirrorSchedule(spec, replica, fault = null) {
  const edge = new Map(spec.transitions.map(t => [`${t.from}\0${t.action}`, t.to]));
  let state = spec.initial; const trace = [];
  for (const [step, { time, action }] of spec.schedule.entries()) {
    const before = state, next = edge.get(`${before}\0${action}`);
    if (!next) { const error = new TypeError(`replica ${replica}: action ${action} not enabled in ${before} at step ${step}`); error.failureStep = step; error.partialTrace = trace; throw error; }
    state = fault?.replica === replica && fault.step === step ? fault.overrideState : next;
    trace.push({ step, time, action, before, after: state });
  }
  const payload = JSON.stringify({ initial: spec.initial, trace, finalState: state });
  return { replica, finalState: state, trace, digest: createHash('sha256').update(payload).digest('hex'),
    forbiddenVisited: (spec.forbiddenStates.includes(spec.initial) ? [{ step: -1, state: spec.initial }] : [])
      .concat(trace.filter(t => spec.forbiddenStates.includes(t.after)).map(t => ({ step: t.step, state: t.after }))) };
}
function isolatedWorker(spec, replica) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mirror-worker.mjs', import.meta.url), { workerData: { spec, replica, fault: spec.fault }, execArgv: [] });
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) { finished = true; worker.terminate().catch(() => {}); reject(new Error(`replica ${replica} timed out`)); }
    }, 8000);
    worker.once('message', message => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (message.ok) resolve(message.result); else { const error = new Error(`replica ${replica}: ${message.error}`); error.failureStep = message.failureStep; error.partialTrace = message.partialTrace; reject(error); }
    });
    worker.once('error', error => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } });
    worker.once('exit', code => {
      if (!finished) { finished = true; clearTimeout(timer); reject(new Error(`replica ${replica} exited ${code} without result`)); }
    });
  });
}
/** Two actual independent Node worker threads, finite declarative transitions, deterministic trace comparison. */
export async function runMirroredAgents(input) {
  const spec = normalize(input);
  const results = await Promise.allSettled([isolatedWorker(spec, 1), isolatedWorker(spec, 2)]);
  const first = results[0].status === 'fulfilled' ? results[0].value : null;
  const second = results[1].status === 'fulfilled' ? results[1].value : null;
  const failedTrace = results.map(r => r.status === 'rejected' ? r.reason.partialTrace ?? null : null);
  const common = first && second ? [first.trace, second.trace] : first && failedTrace[1] ? [first.trace, failedTrace[1]] : second && failedTrace[0] ? [failedTrace[0], second.trace] : null;
  const mismatch = common ? common[0].findIndex((entry, i) => i < common[1].length && JSON.stringify(entry) !== JSON.stringify(common[1][i])) : -1;
  const divergenceStep = mismatch === -1 ? null : mismatch;
  const diverged = !first || !second || divergenceStep !== null || first.digest !== second.digest;
  const violation = !!first && !!second && (first.forbiddenVisited.length > 0 || second.forbiddenVisited.length > 0);
  return { engine: 'NEMESIS_MIRRORED_WORKER_AGENTS_V1', status: diverged ? 'DIVERGED' : violation ? 'INVARIANT_VIOLATION' : 'CONSISTENT',
    actualWorkerThreads: 2, firstDivergenceStep: divergenceStep,
    firstFailureStep: results.map((r, i) => r.status === 'rejected' && Number.isInteger(r.reason.failureStep) ? { replica: i + 1, step: r.reason.failureStep } : null).filter(Boolean),
    errors: results.map((result, i) => result.status === 'rejected' ? { replica: i + 1, message: result.reason.message, partialTrace: result.reason.partialTrace ?? null } : null).filter(Boolean),
    replicas: [first, second], note: 'Agreement between two worker threads running the same interpreter is NOT independent implementation or proof of an external agent, host-code sandbox or Byzantine consensus.' };
}
