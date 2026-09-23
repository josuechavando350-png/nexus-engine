/** Strict finite Kripke-structure validation; inputs are data, never executable code. */
export const LIMITS = Object.freeze({ states: 512, transitions: 65536, properties: 128, formulaNodes: 4096, formulaDepth: 64 });

function record(value, label, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} has unknown key ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}`);
  return value;
}
function array(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new TypeError(`${label} must contain ${min}..${max} entries`);
  return value;
}
function token(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new TypeError(`${label} must be an ASCII identifier (1..128 chars)`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates`);
  return values;
}
export { record, array, token, unique };

/** Normalize and freeze the *same* transition relation used for model checking and agent execution. */
export function normalizeModel(input, { actions = false } = {}) {
  record(input, 'model', ['states', 'initialStates', 'transitions', 'atomicPropositions', 'propositions']);
  const states = unique(array(input.states, 'states', 1, LIMITS.states).map((s, i) => token(s, `states[${i}]`)), 'states').slice().sort();
  const index = new Map(states.map((state, i) => [state, i]));
  const atomicPropositions = unique(array(input.atomicPropositions, 'atomicPropositions', 0, 256).map((s, i) => token(s, `atomicPropositions[${i}]`)), 'atomicPropositions').slice().sort();
  const vocabulary = new Set(atomicPropositions);
  const initialStates = unique(array(input.initialStates, 'initialStates', 1, states.length).map((s, i) => token(s, `initialStates[${i}]`)), 'initialStates').slice().sort();
  for (const state of initialStates) if (!index.has(state)) throw new TypeError(`unknown initial state ${state}`);
  record(input.propositions, 'propositions', states, states);
  const labels = states.map(state => unique(array(input.propositions[state], `propositions.${state}`, 0, 256).map((p, i) => token(p, `propositions.${state}[${i}]`)), `propositions.${state}`).slice().sort());
  for (const [i, labelSet] of labels.entries()) {
    for (const label of labelSet) if (!vocabulary.has(label)) throw new TypeError(`unknown atomic proposition ${label} in state ${states[i]}`);
  }
  const edges = Array.from({ length: states.length }, () => []);
  const transitions = [];
  const seen = new Set();
  for (const [i, raw] of array(input.transitions, 'transitions', 0, LIMITS.transitions).entries()) {
    record(raw, `transitions[${i}]`, actions ? ['from', 'to', 'action'] : ['from', 'to'], actions ? ['from', 'to', 'action'] : ['from', 'to']);
    const from = token(raw.from, `transitions[${i}].from`);
    const to = token(raw.to, `transitions[${i}].to`);
    const action = actions ? token(raw.action, `transitions[${i}].action`) : undefined;
    if (!index.has(from) || !index.has(to)) throw new TypeError(`transitions[${i}] references unknown state`);
    const key = JSON.stringify(actions ? [from, action] : [from, to]);
    if (seen.has(key)) throw new TypeError(`duplicate ${actions ? 'state/action pair' : 'transition'} at transitions[${i}]`);
    seen.add(key);
    const edge = actions ? Object.freeze({ from, to, action }) : Object.freeze({ from, to });
    transitions.push(edge);
    edges[index.get(from)].push(index.get(to));
  }
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  transitions.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.action ?? '', b.action ?? ''));
  const successors = edges.map((row, i) => Object.freeze((row.length ? [...new Set(row)] : [i]).sort((a, b) => a - b)));
  const deadlocks = states.filter((_, i) => edges[i].length === 0);
  const model = {
    states: Object.freeze(states), initialStates: Object.freeze(initialStates), atomicPropositions: Object.freeze(atomicPropositions), index,
    propositions: Object.freeze(labels.map(label => Object.freeze(label))),
    transitions: Object.freeze(transitions), successors: Object.freeze(successors),
    deadlocks: Object.freeze(deadlocks), semantics: 'CTL_TOTAL_KRIPKE_DEADLOCK_STUTTER',
  };
  return Object.freeze(model);
}

export function publicModel(model) {
  return {
    states: model.states,
    initialStates: model.initialStates,
    atomicPropositions: model.atomicPropositions,
    transitions: model.transitions,
    propositions: Object.fromEntries(model.states.map((state, i) => [state, model.propositions[i]])),
    deadlocks: model.deadlocks,
    semantics: model.semantics,
  };
}
