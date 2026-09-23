import { normalizeModel, record, token } from './model.mjs';
import { verifyNormalized } from './verify.mjs';

/** Deterministic, verified finite-state agent; checks the exact immutable action table it executes. */
export function createVerifiedAgent(spec) {
  record(spec, 'agent specification', ['model', 'properties']);
  const model = normalizeModel(spec.model, { actions: true });
  if (model.initialStates.length !== 1) throw new TypeError('an executable agent must have exactly one initial state');
  const verification = verifyNormalized(model, spec.properties);
  if (verification.status !== 'PASS') {
    const error = new Error(`agent verification failed: ${verification.failedRequired.join(', ')}`);
    error.verification = verification;
    throw error;
  }
  const byState = new Map(model.states.map(state => [state, new Map()]));
  for (const edge of model.transitions) byState.get(edge.from).set(edge.action, edge.to);
  let current = model.initialStates[0];
  return Object.freeze({
    verification,
    state: () => current,
    availableActions: () => Object.freeze([...byState.get(current).keys()].sort()),
    execute(action) {
      token(action, 'action');
      const destination = byState.get(current).get(action);
      if (destination === undefined) throw new RangeError(`action ${action} is not permitted in state ${current}`);
      const from = current;
      current = destination;
      return Object.freeze({ from, action, to: current, modelSha256: verification.modelSha256 });
    },
  });
}
