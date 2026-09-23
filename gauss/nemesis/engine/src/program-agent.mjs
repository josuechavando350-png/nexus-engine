import { token } from './model.mjs';
import { verifyFiniteProgram } from './program.mjs';

/**
 * Executes the exact verified transition relation of the finite-program DSL in memory.
 * Does not run JavaScript/TypeScript, perform I/O, or control an external application.
 */
export function createVerifiedProgramAgent(spec) {
  const verification = verifyFiniteProgram(spec);
  if (verification.status !== 'PASS') {
    const error = new Error(`program verification failed: ${verification.failedRequired.join(', ')}`);
    error.verification = verification;
    throw error;
  }
  const byState = new Map(verification.model.states.map(state => [state, new Map()]));
  for (const transition of verification.actionTransitions) {
    const actions = byState.get(transition.from);
    if (actions.has(transition.action)) throw new Error('internal error: duplicate compiled state/action');
    actions.set(transition.action, transition.to);
  }
  let state = verification.model.initialStates[0];
  return Object.freeze({
    verification,
    state: () => state,
    valuation: () => verification.valuations[state],
    availableActions: () => Object.freeze([...byState.get(state).keys()].sort()),
    execute(action) {
      token(action, 'action');
      const to = byState.get(state).get(action);
      if (to === undefined) throw new RangeError(`action ${action} is not permitted in state ${state}`);
      const from = state;
      const before = verification.valuations[from];
      state = to;
      return Object.freeze({ from, action, to, before, after: verification.valuations[to],
        modelSha256: verification.modelSha256, programSha256: verification.programSha256 });
    },
  });
}
